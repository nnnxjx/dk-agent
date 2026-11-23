import { spawnSync } from 'node:child_process';

describe('Embedding authentication failures', () => {
  it('rejects the request without crashing the Node process', () => {
    // A separate process detects fatal unhandled rejections as well as hangs.
    const result = spawnSync(process.execPath, ['-e', `
      const { OpenAIEmbeddings } = require('@langchain/openai');
      let requests = 0;
      const embeddings = new OpenAIEmbeddings({
        openAIApiKey: 'test-only',
        modelName: 'BAAI/bge-m3',
        configuration: {
          fetch: async () => {
            requests++;
            return new Response(JSON.stringify({ message: 'Unauthorized' }), {
              status: 401,
              headers: { 'content-type': 'application/json' },
            });
          },
        },
      });
      (async () => {
        for (const invoke of [
          () => embeddings.embedDocuments(['test']),
          () => embeddings.embedQuery('test'),
        ]) {
          try {
            await invoke();
            throw new Error('Expected authentication failure');
          } catch (error) {
            if (error.status !== 401) throw error;
          }
        }
        if (requests !== 2) throw new Error('401 must not be retried');
        setTimeout(() => console.log('PROCESS_STILL_ALIVE'), 50);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { encoding: 'utf8', timeout: 15000 });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('PROCESS_STILL_ALIVE');
  });
});
