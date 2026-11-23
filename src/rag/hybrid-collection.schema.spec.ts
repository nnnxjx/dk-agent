import { DataType, FunctionType } from '@zilliz/milvus2-sdk-node';
import {
  HYBRID_EMBEDDING_DIM,
  hybridCollectionIndexes,
  hybridCollectionSchema,
} from './hybrid-collection.schema';

jest.mock('@zilliz/milvus2-sdk-node', () => ({
  DataType: { VarChar: 21, JSON: 23, FloatVector: 101, SparseFloatVector: 104 },
  FunctionType: { BM25: 1 },
}));

describe('hybridCollectionSchema', () => {
  it('defines a 1024d dense field and Milvus-generated BM25 sparse field', () => {
    const schema = hybridCollectionSchema('kb_test');
    const text = schema.fields.find((field) => field.name === 'text');
    const dense = schema.fields.find((field) => field.name === 'dense_vector');
    const sparse = schema.fields.find((field) => field.name === 'sparse_vector');

    expect(text).toMatchObject({
      enable_analyzer: true,
      analyzer_params: {
        tokenizer: 'jieba',
        filter: ['cnalphanumonly', 'lowercase'],
      },
    });
    expect(dense).toMatchObject({ data_type: DataType.FloatVector, dim: HYBRID_EMBEDDING_DIM });
    expect(sparse).toMatchObject({ data_type: DataType.SparseFloatVector, is_function_output: true });
    expect(schema.functions[0]).toMatchObject({
      type: FunctionType.BM25,
      input_field_names: ['text'],
      output_field_names: ['sparse_vector'],
    });
    expect(hybridCollectionIndexes('kb_test')).toEqual([
      expect.objectContaining({ field_name: 'dense_vector', metric_type: 'COSINE' }),
      expect.objectContaining({ field_name: 'sparse_vector', metric_type: 'BM25' }),
    ]);
  });

  it('rejects unsafe collection names and dimensions', () => {
    expect(() => hybridCollectionSchema('kb-test')).toThrow('Invalid Milvus collection name');
    expect(() => hybridCollectionSchema('kb_test', 0)).toThrow('Invalid dense vector dimension');
  });
});
