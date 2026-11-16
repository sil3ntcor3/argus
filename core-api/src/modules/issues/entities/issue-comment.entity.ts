import { BaseEntity } from '@/common/entities/base.entity';
import { IssueCommentType } from '@/common/enums/enum';
import { User } from '@/modules/auth/entities/user.entity';
import { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { ApiHideProperty, ApiProperty } from '@nestjs/swagger';
import {
  Check,
  Column,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Relation,
} from 'typeorm';
import { Issue } from './issue.entity';

// Retain the internal class name while legacy issue operations use this store.
// Public resource-comment contracts follow in a separate batch.
@Entity('comments')
@Index('IDX_comments_issueId', ['issue', 'createdAt'])
@Index('IDX_comments_vulnerabilityId', ['vulnerability', 'createdAt'])
@Check('CHK_comments_one_subject', '("issueId" IS NOT NULL)::int + ("vulnerabilityId" IS NOT NULL)::int = 1')
export class IssueComment extends BaseEntity {
  @ApiProperty()
  @Column()
  content: string;

  @ApiProperty({ type: () => User })
  @ManyToOne(() => User)
  @JoinColumn({ name: 'createdById' })
  createdBy: Relation<User>;

  @Column({ nullable: true })
  createdById: string;

  @ManyToOne(() => Issue, (issue) => issue.comments, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({ name: 'issueId' })
  issue: Relation<Issue> | null;

  @Column({ type: 'uuid', nullable: true })
  issueId: string | null;

  @ApiHideProperty()
  @ManyToOne(() => Vulnerability, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'vulnerabilityId' })
  vulnerability?: Relation<Vulnerability> | null;

  @ApiHideProperty()
  @Column({ type: 'uuid', nullable: true, select: false })
  vulnerabilityId?: string | null;

  @ApiProperty()
  @Column({ default: true })
  isCanDelete: boolean;

  @ApiProperty()
  @Column({ default: true })
  isCanEdit: boolean;

  @ApiProperty({
    enum: IssueCommentType,
    default: IssueCommentType.CONTENT,
  })
  @Column({ type: 'varchar', default: IssueCommentType.CONTENT })
  type: IssueCommentType;

  @ApiProperty({ required: false })
  @Column({ nullable: true })
  repCommentId: string;

  @ManyToOne(() => IssueComment)
  @JoinColumn({ name: 'repCommentId' })
  @ApiProperty({ type: () => IssueComment })
  repComment: Relation<IssueComment>;

  @DeleteDateColumn()
  deletedAt: Date;
}
