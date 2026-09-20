import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * 阶段 3：MCP 工具清单缓存（远端发现结果）
 * - serverId + name 唯一；qualifiedName 为 mcp__alias__tool
 * - 远端删除的工具标记 stale，不物理删除，方便审计
 * - enabled=false 的工具不进入 ToolRegistry
 */
@Entity('mcp_tools')
@Index(['serverId', 'name'], { unique: true })
export class McpTool {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ name: 'server_id' })
  serverId: string;

  /** MCP 原始工具名 */
  @Column()
  name: string;

  /** 平台内唯一名称：mcp__<alias>__<tool> */
  @Column({ name: 'qualified_name' })
  qualifiedName: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'input_schema', type: 'json', nullable: true })
  inputSchema: Record<string, unknown> | null;

  @Column({ default: true })
  enabled: boolean;

  /** schema 变化检测：JSON 序列化后的 sha256 */
  @Column({ name: 'schema_hash', nullable: true })
  schemaHash: string | null;

  /** 远端已删除但本地保留审计时为 true */
  @Column({ default: false })
  stale: boolean;

  @Column({ name: 'last_seen_at', type: 'datetime', nullable: true })
  lastSeenAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
