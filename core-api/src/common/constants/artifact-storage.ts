export const ARTIFACT_BUCKET = 'artifacts';
export const ARTIFACT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ARTIFACT_UPLOAD_TTL_SECONDS = 15 * 60;

/** Use server-assigned IDs only; a display filename cannot choose the object key. */
function workspaceArtifactNamespace(workspaceId: string, artifactId: string): string {
  return `workspaces/${workspaceId.toLowerCase()}/${artifactId.toLowerCase()}`;
}

export function workspaceArtifactKey(workspaceId: string, artifactId: string): string {
  return workspaceArtifactNamespace(workspaceId, artifactId) + '/file';
}

export function workspaceArtifactUploadKey(workspaceId: string, artifactId: string): string {
  return workspaceArtifactNamespace(workspaceId, artifactId) + '/upload';
}

export function workspaceArtifactRevisionKey(workspaceId: string, artifactId: string, revisionId: string): string {
  return workspaceArtifactNamespace(workspaceId, artifactId) + '/revisions/' + revisionId.toLowerCase();
}
