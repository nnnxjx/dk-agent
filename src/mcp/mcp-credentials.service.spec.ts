import { McpCredentialsService } from './mcp-credentials.service';

describe('McpCredentialsService (stage 3)', () => {
  it('encrypts and decrypts headers', () => {
    const service = new McpCredentialsService();
    const payload = service.encryptObject({ Authorization: 'Bearer secret' });
    expect(payload).toBeTruthy();
    expect(payload).not.toContain('secret');
    expect(service.decryptObject(payload)).toEqual({
      Authorization: 'Bearer secret',
    });
  });

  it('returns null for empty headers', () => {
    const service = new McpCredentialsService();
    expect(service.encryptObject(undefined)).toBeNull();
    expect(service.decryptObject(null)).toBeUndefined();
  });

  it('masks headers without leaking values', () => {
    const service = new McpCredentialsService();
    expect(
      service.maskHeaders({
        Authorization: 'Bearer secret',
        'X-API-Key': 'key',
      }),
    ).toEqual({
      configured: true,
      keys: ['Authorization', 'X-API-Key'],
    });
    expect(
      JSON.stringify(service.maskHeaders({ Authorization: 'Bearer secret' })),
    ).not.toContain('secret');
  });

  it('rejects tampered payload', () => {
    const service = new McpCredentialsService();
    expect(() => service.decryptObject('v1:00:00:00')).toThrow();
  });
});
