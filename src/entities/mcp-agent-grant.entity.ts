import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 阶段 6：Agent ↔ MCP 工具授权（租户隔离）
 * - 同一租户同一 Agent 对同一 qualifiedName 唯一
 * - 白名单语义：只有落在 grants 里的 MCP 工具才会进入该 Agent 的工具列表
 * - 未建任何 grant 的 Agent 默认无 MCP 工具（默认拒绝）
 * - 删除 Server/工具时由 McpService 级联清理对应 grant（避免幽灵授权）
 */
@Entity('mcp_agent_grants')
@Index(['tenantId', 'agentName', 'qualifiedName'], { unique: true })
export class McpAgentGrant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'tenant_id' })
  tenantId: string;

  @Column({ name: 'agent_name' })
  agentName: string;

  @Column({ name: 'qualified_name' })
  qualifiedName: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
