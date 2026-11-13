import {
  ARTIFACT_BUCKET,
  ARTIFACT_MAX_FILE_BYTES,
  ARTIFACT_UPLOAD_TTL_SECONDS,
  workspaceArtifactKey,
  workspaceArtifactRevisionKey,
  workspaceArtifactUploadKey,
} from '@/common/constants/artifact-storage';
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  type HeadObjectCommandOutput,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
  StreamableFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { DataSource } from 'typeorm';
import { RustFsClient } from './rustfs.client';
import {
  MAX_S3_PRESIGN_TTL_SECONDS,
  MIN_S3_PRESIGN_TTL_SECONDS,
  parseStorageConfig,
  StorageConfig,
} from './storage.config';

interface ArtifactLocation {
  workspaceId: string;
  artifactId: string;
}

interface ArtifactUploadInput extends ArtifactLocation {
  contentType: string;
  sizeBytes: number;
}

function validateArtifactLocation({ workspaceId, artifactId }: ArtifactLocation): void {
  if (workspaceId.length !== 36 || artifactId.length !== 36 || !isUUID(workspaceId) || !isUUID(artifactId)) {
    throw new BadRequestException('Invalid artifact location');
  }
}

function validateArtifactUpload(input: ArtifactUploadInput): void {
  validateArtifactLocation(input);
  const { contentType, sizeBytes } = input;
  if (contentType.length > 255 || contentType.trim() !== contentType || !/^[a-z0-9_.+-]+\/[a-z0-9_.+-]+$/i.test(contentType)) {
    throw new BadRequestException('Invalid artifact content type');
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > ARTIFACT_MAX_FILE_BYTES) {
    throw new BadRequestException('Invalid artifact size');
  }
}

type BucketAccess =
  'public' | 'authenticated' | 'tenant' | 'private' | 'blocked';

const BUCKET_ACCESS = {
  system: 'public',
  screenshot: 'tenant',
  'nuclei-templates': 'tenant',
  'job-results': 'private',
  'cached-static': 'authenticated',
  reports: 'private',
  [ARTIFACT_BUCKET]: 'private',
  default: 'blocked',
} as const satisfies Record<string, BucketAccess>;

export const PUBLIC_READ_BUCKETS: string[] = ['system', 'cached-static'];

/**
 * Start of the current UTC hour. Passed as `signingDate` to `getSignedUrl`
 * (supported via `RequestPresigningArguments` in the installed
 * `@smithy/types@4.19`) so repeated presigns within the same hour emit
 * byte-identical URLs; the URL changes after the hour rolls over. Never in
 * the future — flooring `now` can only move backwards within the hour.
 *
 * Only safe when the TTL absorbs the worst-case 59:59 intra-hour offset
 * (SigV4 expiry = X-Amz-Date + X-Amz-Expires). Both presign helpers gate on
 * `HOUR_BUCKET_MIN_TTL_SECONDS` and sign `new Date()` below it.
 */
export function getHourBucketedSigningDate(now: Date = new Date()): Date {
  const bucketed = new Date(now);
  bucketed.setUTCMinutes(0, 0, 0);
  return bucketed;
}

/** Build an attachment header without allowing a filename to change its syntax. */
export function attachmentDisposition(fileName: string): string {
  // UTF-8 round-tripping replaces lone surrogates before URI encoding.
  const name = Buffer.from(fileName, 'utf8').toString('utf8');
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Minimum clamped TTL that may use the hour-bucketed signing date (2h). */
export const HOUR_BUCKET_MIN_TTL_SECONDS = 7200;

const EXTENSION_TO_MIME: Record<string, string> = {
  // Images
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',

  // Documents
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',

  // Archives
  zip: 'application/zip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',

  // Audio/Video
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',

  // Code
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  css: 'text/css',
  js: 'application/javascript',
  ts: 'application/typescript',
};

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly buckets = Object.keys(BUCKET_ACCESS);

  private readonly publicReadApplied = new Set<string>();

  public getBucketAccess(bucket: string): BucketAccess {
    return (BUCKET_ACCESS as Record<string, BucketAccess>)[bucket] ?? 'blocked';
  }

  public getPresignTtlSeconds(): number {
    return this.storageConfig.presignTtlSeconds;
  }

  private readonly restrictedExtensions = [
    'exe',
    'dll',
    'bat',
    'sh',
    'js',
    'php',
    'py',
    'pl',
    'rb',
    'jar',
  ];

  private readonly storageConfig: StorageConfig;

  constructor(
    private readonly rustFsClient: RustFsClient,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.storageConfig = parseStorageConfig(this.configService);
  }

  private toBrowserUrl(absolute: string): string {
    if (this.storageConfig.urlBase === '') {
      return absolute;
    }
    const u = new URL(absolute);
    return `${this.storageConfig.urlBase}${u.pathname}${u.search}`;
  }

  async onModuleInit() {
    await this.ensureBucketsExist();
    await this.applyBucketCors();
    await this.applyPublicReadPolicy();
  }

  private async applyBucketCors() {
    const origins = this.storageConfig.corsAllowedOrigins;
    if (origins.length === 0) {
      return;
    }
    const client = this.rustFsClient.getClient();
    for (const bucket of this.buckets) {
      try {
        await client.send(
          new PutBucketCorsCommand({
            Bucket: bucket,
            CORSConfiguration: {
              CORSRules: [
                {
                  AllowedHeaders: ['*'],
                  AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
                  AllowedOrigins: origins,
                  MaxAgeSeconds: 3000,
                  ExposeHeaders: ['ETag'],
                },
              ],
            },
          }),
        );
      } catch (error) {
        this.logger.warn(
          `Failed to apply CORS to bucket ${bucket}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
  }

  /**
   * Grants anonymous `s3:GetObject` on the public buckets (`system`,
   * `cached-static`) and records each bucket in `publicReadApplied` ONLY after
   * a mandatory verification gate — fail-closed, Todo 3 presigns otherwise.
   *
   * Per bucket: (1) best-effort `PutPublicAccessBlock` with all four flags
   * `false` — a `NotImplemented`/error here MUST NOT disable the feature
   * (RustFS may not implement it); (2) `PutBucketPolicy` granting GetObject-only
   * on `arn:aws:s3:::<bucket>/*` to `Principal: "*"` (never Put/Delete/List).
   * The flag is set only after `GetBucketPolicyStatus` reports `IsPublic`
   * (object-independent proof; fresh buckets may be empty so an unsigned
   * HEAD probe has no known key to hit). Any failure → `Logger.warn`, flag
   * stays off, boot continues.
   *
   * Required IAM: `s3:PutBucketPolicy` (+ `s3:PutBucketPublicAccessBlock` when
   * the account enforces Block Public Access).
   */
  private async applyPublicReadPolicy() {
    const client = this.rustFsClient.getClient();
    for (const bucket of PUBLIC_READ_BUCKETS) {
      try {
        try {
          await client.send(
            new PutPublicAccessBlockCommand({
              Bucket: bucket,
              PublicAccessBlockConfiguration: {
                BlockPublicAcls: false,
                IgnorePublicAcls: false,
                BlockPublicPolicy: false,
                RestrictPublicBuckets: false,
              },
            }),
          );
        } catch {
          this.logger.debug(
            `Public access block not applied to bucket ${bucket}; continuing with bucket policy`,
          );
        }
        await client.send(
          new PutBucketPolicyCommand({
            Bucket: bucket,
            Policy: JSON.stringify({
              Version: '2012-10-17',
              Statement: [
                {
                  Sid: 'PublicReadGetObject',
                  Effect: 'Allow',
                  Principal: '*',
                  Action: 's3:GetObject',
                  Resource: `arn:aws:s3:::${bucket}/*`,
                },
              ],
            }),
          }),
        );
      } catch (error) {
        this.logger.warn(
          `Failed to apply public-read policy to bucket ${bucket}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
        continue;
      }
      try {
        const status = await client.send(
          new GetBucketPolicyStatusCommand({ Bucket: bucket }),
        );
        if (status.PolicyStatus?.IsPublic === true) {
          this.publicReadApplied.add(bucket);
        } else {
          this.logger.warn(
            `Public-read verification failed for bucket ${bucket}: policy not reported public`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `Public-read verification failed for bucket ${bucket}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    }
  }

  public assertBucketAllowed(bucket: string): void {
    if (!bucket || bucket.trim() === '') {
      throw new BadRequestException('bucket is required');
    }
    if (!this.buckets.includes(bucket)) {
      throw new BadRequestException(
        `Invalid bucket: ${bucket}. Allowed buckets: ${this.buckets.join(', ')}`,
      );
    }
  }

  public assertBucketNotPrivate(bucket: string): void {
    if (this.getBucketAccess(bucket) === 'private') {
      throw new ForbiddenException(`Bucket '${bucket}' is private`);
    }
  }

  /**
   * Resolves ALL workspaces that own a tenant-bucket object. Screenshot
   * object keys are `md5(asset.value)` and can collide across workspaces,
   * so a single arbitrary row is never enough — every distinct owner is
   * returned and the caller authorizes membership of ANY of them.
   */
  public async resolveObjectWorkspaceIds(
    bucket: string,
    key: string,
  ): Promise<string[]> {
    if (bucket === 'screenshot') {
      const rows: Array<{ workspaceId: string }> = await this.dataSource.query(
        `SELECT DISTINCT targets."workspaceId" AS "workspaceId"
         FROM asset_services
         INNER JOIN assets ON assets.id = asset_services."assetId"
         INNER JOIN targets ON targets.id = assets."targetId"
         WHERE asset_services."screenshotPath" = $1`,
        [`screenshot/${key}`],
      );
      return [...new Set(rows.map((row) => row.workspaceId))];
    }
    if (bucket === 'nuclei-templates') {
      const dotIndex = key.lastIndexOf('.');
      const templateId = dotIndex > 0 ? key.slice(0, dotIndex) : key;
      const rows: Array<{ workspaceId: string }> = await this.dataSource.query(
        `SELECT templates."workspaceId" AS "workspaceId"
         FROM templates
         WHERE templates.id = $1`,
        [templateId],
      );
      return [...new Set(rows.map((row) => row.workspaceId))];
    }
    return [];
  }

  public generateObjectKey(
    fileName: string,
    opts?: { allowedExtensions?: string[]; prefix?: string },
  ): string {
    const dotIndex = fileName.lastIndexOf('.');
    const ext =
      dotIndex > 0 && dotIndex < fileName.length - 1
        ? fileName.slice(dotIndex + 1).toLowerCase()
        : '';

    if (!ext) {
      throw new BadRequestException('File must have an extension');
    }
    if (this.restrictedExtensions.includes(ext)) {
      throw new BadRequestException(`File extension '.${ext}' is restricted`);
    }
    if (
      opts?.allowedExtensions &&
      !opts.allowedExtensions.map((e) => e.toLowerCase()).includes(ext)
    ) {
      throw new BadRequestException(
        `File extension '.${ext}' is not allowed. Allowed extensions: ${opts.allowedExtensions.join(', ')}`,
      );
    }

    return `${opts?.prefix ? opts.prefix + '-' : ''}${randomUUID()}.${ext}`;
  }

  private async ensureBucketsExist() {
    const client = this.rustFsClient.getClient();
    for (const bucket of this.buckets) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (
          error instanceof S3ServiceException &&
          (error.$metadata.httpStatusCode === 404 ||
            error.name === 'NoSuchBucket')
        ) {
          try {
            await client.send(new CreateBucketCommand({ Bucket: bucket }));
            this.logger.log(`Created bucket: ${bucket}`);
          } catch (createError) {
            if (
              createError instanceof S3ServiceException &&
              createError.name === 'BucketAlreadyExists'
            ) {
              this.logger.debug(`Bucket already exists: ${bucket}`);
            } else {
              this.logger.error(
                `Failed to create bucket ${bucket}: ${createError instanceof Error ? createError.message : 'Unknown error'}`,
              );
            }
          }
        } else {
          this.logger.error(
            `Failed to check bucket ${bucket}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
      }
    }
  }

  public async uploadFile(
    fileName: string,
    buffer: Buffer,
    bucket: string = 'default',
    contentType?: string,
    abortSignal?: AbortSignal,
  ) {
    abortSignal?.throwIfAborted();
    const client = this.rustFsClient.getClient();
    const dotIndex = fileName.lastIndexOf('.');
    const derivedType =
      dotIndex > 0 && dotIndex < fileName.length - 1
        ? this.resolveMimeType(fileName.slice(dotIndex + 1))
        : undefined;
    const resolvedContentType =
      contentType ?? derivedType ?? 'application/octet-stream';
    const putObject = () =>
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fileName,
          Body: buffer,
          ContentType: resolvedContentType,
        }),
        { abortSignal },
      );

    try {
      await putObject();
    } catch (error: unknown) {
      abortSignal?.throwIfAborted();
      // The happy path stays a single round-trip — no HeadBucket probe, no
      // bucket churn. Only a genuinely missing bucket pays for a CreateBucket
      // plus exactly one retry. A concurrent `onModuleInit` caller can reach
      // this before `StorageService.onModuleInit` has created the buckets, and
      // for one-shot startup syncs (e.g. ToolSyncService uploading connector
      // logos) a failure here would never be retried.
      if (!this.isNoSuchBucket(error)) {
        throw this.toUploadError(error);
      }

      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal });
        this.logger.log(`Created bucket on demand: ${bucket}`);
      } catch (createError: unknown) {
        abortSignal?.throwIfAborted();
        // Lost the race against another instance that created it first — the
        // bucket exists either way, so the retry below is still correct.
        if (!this.isBucketAlreadyExists(createError)) {
          throw this.toUploadError(createError);
        }
      }

      try {
        await putObject();
      } catch (retryError: unknown) {
        abortSignal?.throwIfAborted();
        throw this.toUploadError(retryError);
      }
    }

    abortSignal?.throwIfAborted();
    return { path: `${bucket}/${fileName}` };
  }

  private clampPresignTtl(requestedTtl: number): number {
    const clampedTtl = Math.min(
      MAX_S3_PRESIGN_TTL_SECONDS,
      Math.max(MIN_S3_PRESIGN_TTL_SECONDS, Math.trunc(requestedTtl)),
    );
    return clampedTtl;
  }

  private async signCommand(
    command: PutObjectCommand | GetObjectCommand,
    ttl: number,
    extra?: { signableHeaders?: Set<string> },
  ): Promise<string> {
    // ponytail: presigner@3.1048 vs client-s3@3.1097 ship mismatched @smithy/types; cast until versions align.
    return getSignedUrl(
      this.rustFsClient.getPresignClient() as never,
      command as never,
      {
        expiresIn: ttl,
        signingDate:
          ttl >= HOUR_BUCKET_MIN_TTL_SECONDS
            ? getHourBucketedSigningDate()
            : new Date(),
        ...(extra ?? {}),
      },
    );
  }

  public async getPresignedUploadUrl(opts: {
    bucket: string;
    key: string;
    contentType?: string;
    expiresIn?: number;
  }): Promise<{ url: string; key: string; path: string; expiresIn: number }> {
    const { bucket, key, contentType, expiresIn } = opts;

    if (!bucket || bucket.trim() === '') {
      throw new BadRequestException('bucket is required');
    }
    if (
      !key ||
      key.trim() === '' ||
      key.startsWith('/') ||
      key.startsWith('.') ||
      key.startsWith(' ') ||
      key.includes('..')
    ) {
      throw new BadRequestException('Invalid key');
    }

    const clampedTtl = this.clampPresignTtl(
      expiresIn ?? this.storageConfig.presignTtlSeconds,
    );

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      ...(contentType ? { ContentType: contentType } : {}),
    });

    const url = await this.signCommand(
      command,
      clampedTtl,
      contentType ? { signableHeaders: new Set(['content-type']) } : undefined,
    );

    return {
      url: this.toBrowserUrl(url),
      key,
      path: `${bucket}/${key}`,
      expiresIn: clampedTtl,
    };
  }

  /**
   * Private form for one allocated artifact's staging object. The form can
   * overwrite that object until expiry, so it must never name the final key.
   * Callers authorize the workspace and reserve quota before returning it.
   */
  public async getPresignedArtifactUpload(
    input: ArtifactUploadInput,
  ): Promise<{ url: string; fields: Record<string, string>; expiresAt: Date }> {
    validateArtifactUpload(input);
    const { workspaceId, artifactId, contentType, sizeBytes } = input;

    // The SDK also pins Bucket, Key, and each field (including Content-Type)
    // as exact conditions. This key never ends with its filename wildcard.
    const { url, fields } = await createPresignedPost(this.rustFsClient.getPresignClient(), {
      Bucket: ARTIFACT_BUCKET,
      Key: workspaceArtifactUploadKey(workspaceId, artifactId),
      Conditions: [['content-length-range', sizeBytes, sizeBytes]],
      Fields: { 'Content-Type': contentType },
      Expires: ARTIFACT_UPLOAD_TTL_SECONDS,
    });
    // Use the signed deadline, including the SDK's clock offset and rounding.
    // Cleanup must not delete a pending record while its form is still valid.
    const policy = JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf8')) as {
      expiration?: unknown;
    };
    const expiresAt = new Date(typeof policy.expiration === 'string' ? policy.expiration : NaN);
    if (!Number.isFinite(expiresAt.getTime())) {
      throw new InternalServerErrorException('Invalid artifact upload deadline');
    }
    return { url: this.toBrowserUrl(url), fields, expiresAt };
  }

  /**
   * Copy verified staging bytes into the server-owned key exactly once.
   * A retry after the database transaction fails can recognize its prior
   * copy without trusting or overwriting the now-replayable staging object.
   */
  public async publishArtifactUpload(input: ArtifactUploadInput): Promise<void> {
    validateArtifactUpload(input);
    const { workspaceId, artifactId, contentType, sizeBytes } = input;
    const stagingKey = workspaceArtifactUploadKey(workspaceId, artifactId);
    const finalKey = workspaceArtifactKey(workspaceId, artifactId);
    const marker = artifactId.toLowerCase();
    // Completion holds database locks; bound all requests and retries together.
    const abortSignal = AbortSignal.timeout(15_000);

    const alreadyPublished = async () => {
      const final = await this.headArtifactObject(finalKey, abortSignal);
      if (!final) return false;
      if (final.Metadata?.['argus-artifact-id'] !== marker ||
          final.ContentLength !== sizeBytes || final.ContentType !== contentType) {
        throw new ConflictException('Unexpected file at the final artifact key');
      }
      return true;
    };
    if (await alreadyPublished()) return;

    const staged = await this.headArtifactObject(stagingKey, abortSignal);
    if (!staged) {
      throw new NotFoundException('Artifact upload has not arrived');
    }
    if (staged.ContentLength !== sizeBytes || staged.ContentType !== contentType || !staged.ETag) {
      throw new ConflictException('Artifact upload does not match the reservation');
    }

    try {
      await this.rustFsClient.getClient().send(new CopyObjectCommand({
        Bucket: ARTIFACT_BUCKET,
        Key: finalKey,
        CopySource: `${ARTIFACT_BUCKET}/${stagingKey}`,
        CopySourceIfMatch: staged.ETag,
        IfNoneMatch: '*',
        MetadataDirective: 'REPLACE',
        Metadata: { 'argus-artifact-id': marker },
        ContentType: contentType,
        CacheControl: 'private, no-store',
      }), { abortSignal });
    } catch (error: unknown) {
      if (!(error instanceof S3ServiceException)) throw error;
      const status = error.$metadata.httpStatusCode;
      if (status !== 412 && !(status === 409 && error.name === 'ConditionalRequestConflict')) {
        throw error;
      }
      // Another completion may have won the destination precondition.
      // Otherwise the source changed; do not publish bytes we did not check.
      if (!(await alreadyPublished())) {
        throw new ConflictException('Artifact upload changed before completion');
      }
    }
  }

  /** Publish a fresh server-owned revision without replacing any existing bytes. */
  public async publishArtifactRevision(input: ArtifactLocation & {
    revisionId: string; buffer: Buffer; contentType: string; abortSignal?: AbortSignal;
  }): Promise<string> {
    validateArtifactUpload({ ...input, sizeBytes: input.buffer.length });
    if (input.revisionId.length !== 36 || !isUUID(input.revisionId)) {
      throw new BadRequestException('Invalid artifact revision');
    }
    const key = workspaceArtifactRevisionKey(input.workspaceId, input.artifactId, input.revisionId);
    const deadline = AbortSignal.timeout(15_000);
    const abortSignal = input.abortSignal ? AbortSignal.any([input.abortSignal, deadline]) : deadline;
    abortSignal.throwIfAborted();
    try {
      await this.rustFsClient.getClient().send(new PutObjectCommand({
        Bucket: ARTIFACT_BUCKET, Key: key, Body: input.buffer,
        ContentType: input.contentType, CacheControl: 'private, no-store',
        Metadata: { 'argus-artifact-id': input.artifactId.toLowerCase() },
        IfNoneMatch: '*',
      }), { abortSignal });
    } catch (error: unknown) {
      if (error instanceof S3ServiceException && [409, 412].includes(error.$metadata.httpStatusCode ?? 0)) {
        throw new ConflictException('Artifact revision already exists');
      }
      throw error;
    }
    return key;
  }

  /** Remove the two canonical keys of an expired upload or deleted file. */
  public async deleteArtifactUploadObjects(location: ArtifactLocation): Promise<void> {
    validateArtifactLocation(location);
    const { workspaceId, artifactId } = location;
    const client = this.rustFsClient.getClient();
    const abortSignal = AbortSignal.timeout(15_000);
    for (const Key of [workspaceArtifactUploadKey(workspaceId, artifactId), workspaceArtifactKey(workspaceId, artifactId)]) {
      await client.send(new DeleteObjectCommand({ Bucket: ARTIFACT_BUCKET, Key }), { abortSignal });
    }
  }

  private async headArtifactObject(
    key: string, abortSignal: AbortSignal,
  ): Promise<HeadObjectCommandOutput | undefined> {
    try {
      return await this.rustFsClient.getClient().send(new HeadObjectCommand({
        Bucket: ARTIFACT_BUCKET, Key: key,
      }), { abortSignal });
    } catch (error: unknown) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return undefined;
      }
      throw error;
    }
  }

  public async getPresignedDownloadUrl(opts: {
    bucket: string;
    key: string;
    expiresIn?: number;
    fileName?: string;
    contentType?: string;
  }): Promise<{ url: string; expiresIn: number }> {
    const { bucket, key, expiresIn, fileName, contentType } = opts;

    if (!bucket || bucket.trim() === '') {
      throw new BadRequestException('bucket is required');
    }
    if (
      !key ||
      key.trim() === '' ||
      key.startsWith('/') ||
      key.startsWith('.') ||
      key.startsWith(' ') ||
      key.includes('..')
    ) {
      throw new BadRequestException('Invalid key');
    }

    const clampedTtl = this.clampPresignTtl(
      expiresIn ?? this.storageConfig.presignTtlSeconds,
    );

    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: fileName
        ? attachmentDisposition(fileName)
        : undefined,
      ResponseContentType: contentType || undefined,
    });

    const url = await this.signCommand(command, clampedTtl);

    return { url: this.toBrowserUrl(url), expiresIn: clampedTtl };
  }

  public resolveMimeType(extension?: string): string | undefined {
    if (!extension) return undefined;
    return EXTENSION_TO_MIME[extension.toLowerCase()];
  }

  /**
   * Browser-consumable URL for a stored `bucket/key` path. Pure async with no
   * shared mutable reads beyond the applied-flag set, so per-item calls on list
   * endpoints stay `Promise.all`-safe. Never stores the returned URL.
   */
  public async getClientUrlForPath(
    path: string,
    opts?: { expiresIn?: number },
  ): Promise<{ url: string; expiresIn: number | null }> {
    const slashIndex = path.indexOf('/');
    if (slashIndex <= 0 || slashIndex === path.length - 1) {
      throw new BadRequestException('Invalid path');
    }
    const bucket = path.slice(0, slashIndex);
    const key = path.slice(slashIndex + 1);

    this.assertBucketAllowed(bucket);
    const access = this.getBucketAccess(bucket);
    if (access === 'private' || access === 'blocked') {
      throw new BadRequestException(`Bucket '${bucket}' is private`);
    }

    if (
      PUBLIC_READ_BUCKETS.includes(bucket) &&
      this.publicReadApplied.has(bucket)
    ) {
      const encodedKey = key
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      if (this.storageConfig.urlBase !== '') {
        return {
          url: `${this.storageConfig.urlBase}/${bucket}/${encodedKey}`,
          expiresIn: null,
        };
      }
      const endpoint = this.storageConfig.publicEndpoint.replace(/\/+$/, '');
      if (this.storageConfig.forcePathStyle) {
        return { url: `${endpoint}/${bucket}/${encodedKey}`, expiresIn: null };
      }
      // ponytail: virtual-hosted style needs scheme + host split; URL parse ceiling is malformed-endpoint throw.
      const parsed = new URL(endpoint);
      return {
        url: `${parsed.protocol}//${bucket}.${parsed.host}/${encodedKey}`,
        expiresIn: null,
      };
    }

    const contentType = this.deriveContentTypeFromKey(key);
    return this.getPresignedDownloadUrl({
      bucket,
      key,
      expiresIn: opts?.expiresIn,
      ...(contentType ? { contentType } : {}),
    });
  }

  /**
   * Batched signing helper. Thin orchestrator over the existing per-path
   * logic — no duplicated signing code. `Promise.all`-safe (pure async, no
   * shared mutable state beyond `publicReadApplied` reads) and preserves
   * output order. Private/blocked items reject with 400 (never silently
   * skipped); malformed stored rows (no `/`, leading `/`, empty key) resolve
   * to `null` so one bad row never fails a whole list — direct invalid input
   * still throws via `getClientUrlForPath`.
   */
  public async signStoragePaths(
    items: Array<{ bucket: string; path: string }>,
    expiresIn?: number,
  ): Promise<Array<string | null>> {
    return Promise.all(
      items.map(async (item): Promise<string | null> => {
        const fullPath = item.path.includes('/')
          ? item.path
          : `${item.bucket}/${item.path}`;
        const slashIndex = fullPath.indexOf('/');
        if (
          slashIndex <= 0 ||
          slashIndex === fullPath.length - 1 ||
          fullPath.startsWith('/')
        ) {
          return null;
        }
        const { url } = await this.getClientUrlForPath(
          fullPath,
          expiresIn !== undefined ? { expiresIn } : undefined,
        );
        return url;
      }),
    );
  }

  /**
   * Single-path wrapper over `signStoragePaths`. Parses `bucket/key`,
   * delegates, returns the single URL (or `null` for a malformed stored
   * path instead of throwing, so detail views degrade to "no image").
   */
  public async signStoragePath(
    path: string,
    opts?: { expiresIn?: number },
  ): Promise<string | null> {
    const slashIndex = path.indexOf('/');
    const bucket = slashIndex > 0 ? path.slice(0, slashIndex) : '';
    const [url] = await this.signStoragePaths(
      [
        {
          bucket,
          path,
        },
      ],
      opts?.expiresIn,
    );
    return url ?? null;
  }

  private deriveContentTypeFromKey(key: string): string | undefined {
    const dotIndex = key.lastIndexOf('.');
    return dotIndex > 0 && dotIndex < key.length - 1
      ? this.resolveMimeType(key.slice(dotIndex + 1))
      : undefined;
  }

  private isNoSuchBucket(error: unknown): boolean {
    return (
      error instanceof S3ServiceException &&
      (error.name === 'NoSuchBucket' || error.$metadata.httpStatusCode === 404)
    );
  }

  private isBucketAlreadyExists(error: unknown): boolean {
    return (
      error instanceof S3ServiceException &&
      (error.name === 'BucketAlreadyExists' ||
        error.name === 'BucketAlreadyOwnedByYou' ||
        error.$metadata.httpStatusCode === 409)
    );
  }

  private toUploadError(error: unknown): InternalServerErrorException {
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error occurred';
    return new InternalServerErrorException(
      `Failed to save file: ${errorMessage}`,
    );
  }

  public async getFile(
    filePath: string,
    bucket: string = 'default',
  ): Promise<{
    file: StreamableFile;
    etag: string | null;
    lastModified: Date | null;
  }> {
    const cleanPath = filePath.replace(/^[./\s]+/, '');

    if (!cleanPath || cleanPath.includes('..')) {
      throw new NotFoundException('File not found');
    }

    try {
      const response = await this.rustFsClient.getClient().send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: cleanPath,
        }),
      );

      if (!response.Body) {
        throw new NotFoundException('File not found');
      }

      const body = response.Body as Readable;
      return {
        file: new StreamableFile(body),
        etag: response.ETag ?? null,
        lastModified: response.LastModified ?? null,
      };
    } catch (error: unknown) {
      if (
        error instanceof S3ServiceException &&
        (error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404)
      ) {
        throw new NotFoundException('File not found');
      }
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      throw new InternalServerErrorException(
        `Failed to get file: ${errorMessage}`,
      );
    }
  }

  public async headObject(
    bucket: string,
    key: string,
  ): Promise<{ contentType: string | null; contentLength: number }> {
    try {
      const response = await this.rustFsClient.getClient().send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );

      return {
        contentType: response.ContentType ?? null,
        contentLength: response.ContentLength ?? 0,
      };
    } catch (error: unknown) {
      if (
        error instanceof S3ServiceException &&
        (error.name === 'NoSuchKey' ||
          error.name === 'NotFound' ||
          error.$metadata.httpStatusCode === 404)
      ) {
        throw new NotFoundException('File not found');
      }
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      throw new InternalServerErrorException(
        `Failed to stat file: ${errorMessage}`,
      );
    }
  }

  /**
   * Lists all object keys in a bucket with their last-modified timestamps,
   * following pagination. Used by cleanup jobs that need to scan a whole bucket.
   *
   * @param bucket - The bucket to list.
   * @returns An array of `{ key, lastModified }` entries (key omitted objects are skipped).
   */
  public async listFiles(
    bucket: string,
  ): Promise<Array<{ key: string; lastModified?: Date }>> {
    const client = this.rustFsClient.getClient();
    const files: Array<{ key: string; lastModified?: Date }> = [];
    let continuationToken: string | undefined;

    try {
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ContinuationToken: continuationToken,
          }),
        );

        for (const obj of response.Contents ?? []) {
          if (obj.Key) {
            files.push({ key: obj.Key, lastModified: obj.LastModified });
          }
        }

        continuationToken = response.NextContinuationToken;
      } while (continuationToken);
    } catch (error: unknown) {
      if (
        error instanceof S3ServiceException &&
        (error.name === 'NoSuchBucket' ||
          error.$metadata.httpStatusCode === 404)
      ) {
        throw new NotFoundException('Bucket not found');
      }
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      throw new InternalServerErrorException(
        `Failed to list files: ${errorMessage}`,
      );
    }

    return files;
  }

  /** Fetch a bounded page without relying on a provider continuation token surviving deletions. */
  public async listArtifactSweepPage(startAfter?: string) {
    const prefix = 'workspaces/';
    const page = await this.rustFsClient.getClient().send(new ListObjectsV2Command({
      Bucket: ARTIFACT_BUCKET, Prefix: prefix, MaxKeys: 500, StartAfter: startAfter,
    }), { abortSignal: AbortSignal.timeout(15_000) });
    const objects = page.Contents ?? [];
    const nextKey = page.IsTruncated ? objects.at(-1)?.Key : undefined;
    if (page.IsTruncated && (!nextKey?.startsWith(prefix) ||
        (startAfter && Buffer.compare(Buffer.from(nextKey), Buffer.from(startAfter)) <= 0))) {
      throw new Error('Artifact staging listing did not advance');
    }
    return { objects, nextKey };
  }

  /** Delete exact keys already authorized by the bounded artifact sweep. */
  public async deleteArtifactSweepObjects(keys: string[]): Promise<number> {
    return (await this.deleteArtifactSweepFailures(keys)).length;
  }

  /** Return exact failed keys so retirement records survive partial S3 failures. */
  public async deleteArtifactSweepFailures(keys: string[]): Promise<string[]> {
    const result = await this.rustFsClient.getClient().send(new DeleteObjectsCommand({
      Bucket: ARTIFACT_BUCKET,
      Delete: {
        Objects: keys.map(Key => ({ Key })),
        Quiet: true,
      },
    }), { abortSignal: AbortSignal.timeout(15_000) });
    if (result.Errors?.some(error => !error.Key || !keys.includes(error.Key))) return keys;
    return result.Errors?.map(error => error.Key!) ?? [];
  }

  /**
   * Sweep one workspace's private artifact keys after its writers are stopped.
   * Run this outside the database transaction; failed object deletes can be retried.
   */
  public async deleteWorkspaceArtifacts(
    workspaceId: string,
  ): Promise<{ deleted: number; failed: number }> {
    if (workspaceId.length !== 36 || !isUUID(workspaceId)) {
      throw new BadRequestException('Invalid workspace ID');
    }

    const bucket = ARTIFACT_BUCKET;
    const prefix = `workspaces/${workspaceId.toLowerCase()}/`;
    const client = this.rustFsClient.getClient();
    const abortSignal = AbortSignal.timeout(30_000);
    const seenTokens = new Set<string>();
    let continuationToken: string | undefined;
    let deleted = 0;
    let failed = 0;

    do {
      const page = await client.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix, ContinuationToken: continuationToken,
      }), { abortSignal });
      const next = page.IsTruncated ? page.NextContinuationToken : undefined;
      if (page.IsTruncated && (!next || seenTokens.has(next))) {
        throw new Error('Workspace artifact listing did not advance');
      }
      if (next) seenTokens.add(next);

      for (const { Key } of page.Contents ?? []) {
        abortSignal.throwIfAborted();
        // Do not send a delete for a key outside the requested workspace,
        // even if an S3-compatible provider returns it for this prefix.
        if (!Key?.startsWith(prefix)) {
          failed++;
          continue;
        }
        try {
          await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }), { abortSignal });
          deleted++;
        } catch {
          failed++;
        }
      }
      continuationToken = next;
    } while (continuationToken);

    return { deleted, failed };
  }

  public async deleteFile(
    filePath: string,
    bucket: string = 'default',
  ): Promise<void> {
    const cleanPath = filePath.replace(/^[./\s]+/, '');

    if (!cleanPath || cleanPath.includes('..')) {
      throw new NotFoundException('File not found');
    }

    try {
      await this.rustFsClient.getClient().send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: cleanPath,
        }),
      );
    } catch (error: unknown) {
      if (
        error instanceof S3ServiceException &&
        (error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404)
      ) {
        throw new NotFoundException('File not found');
      }
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      throw new InternalServerErrorException(
        `Failed to delete file: ${errorMessage}`,
      );
    }
  }

  public async forwardImage(
    url: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    try {
      new URL(url);
    } catch (err) {
      Logger.error(err);
      throw new BadRequestException('Invalid URL format');
    }

    try {
      const response = await fetch(url);

      if (!response.ok) {
        throw new NotFoundException('Image not found at the provided URL');
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.startsWith('image/')) {
        throw new BadRequestException(
          'The provided URL does not point to an image',
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      return { buffer, contentType };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new BadRequestException(
        'Failed to fetch image from the provided URL',
      );
    }
  }

  public async readJsonFile<T>(
    filePath: string,
    bucket: string = 'default',
  ): Promise<T> {
    const cleanPath = filePath.replace(/^[./\s]+/, '');

    if (!cleanPath || cleanPath.includes('..')) {
      throw new NotFoundException('File not found');
    }

    try {
      const response = await this.rustFsClient.getClient().send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: cleanPath,
        }),
      );

      if (!response.Body) {
        throw new NotFoundException('File not found');
      }

      const body = response.Body as Readable;
      const chunks: Buffer[] = [];
      for await (const chunk of body) {
        chunks.push(Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks).toString('utf8');
      return JSON.parse(content) as T;
    } catch (error: unknown) {
      if (
        error instanceof S3ServiceException &&
        (error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404)
      ) {
        throw new NotFoundException('File not found');
      }
      if (error instanceof SyntaxError) {
        throw new InternalServerErrorException(
          `Failed to parse JSON file: ${error.message}`,
        );
      }
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      throw new InternalServerErrorException(
        `Failed to read or parse JSON file: ${errorMessage}`,
      );
    }
  }
}
