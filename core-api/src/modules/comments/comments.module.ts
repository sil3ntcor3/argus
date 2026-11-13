import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IssueComment } from '@/modules/issues/entities/issue-comment.entity';
import { Issue } from '@/modules/issues/entities/issue.entity';
import { Vulnerability } from '@/modules/vulnerabilities/entities/vulnerability.entity';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';

@Module({
  imports: [TypeOrmModule.forFeature([IssueComment, Issue, Vulnerability])],
  controllers: [CommentsController],
  providers: [CommentsService],
})
export class CommentsModule {}
