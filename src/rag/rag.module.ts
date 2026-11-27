import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { KnowledgeBase } from '../entities/knowledge-base.entity';
import { RagService } from './rag.service';
import { MilvusService } from './milvus.service';
import { DocumentLoaderService } from './document-loader.service';
import { GlobalRerankService } from './global-rerank.service';
import { RagController } from './rag.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([KnowledgeBase]),
    MulterModule.register({
      storage: memoryStorage(),
      limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    }),
  ],
  controllers: [RagController],
  providers: [GlobalRerankService, RagService, MilvusService, DocumentLoaderService],
  exports: [GlobalRerankService, RagService, MilvusService],
})
export class RagModule {}
