import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { RunRegistry } from './run-registry.service';
import { AgentModule } from '../agent/agent.module';
import { LLMModule } from '../llm/llm.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Conversation, Message]),
    AgentModule,
    LLMModule,
  ],
  controllers: [ChatController],
  providers: [ChatService, RunRegistry],
  exports: [ChatService, RunRegistry],
})
export class ChatModule {}
