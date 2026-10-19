import { DataType, FunctionType } from '@zilliz/milvus2-sdk-node';

export const HYBRID_EMBEDDING_DIM = 1024;
export const HYBRID_ANALYZER_PARAMS = { type: 'chinese' } as const;

/** 只用于全新 Milvus 2.6 集合；旧 2.3 Collection 不能原地补 BM25 Function。 */
export function hybridCollectionSchema(collectionName: string, dim = HYBRID_EMBEDDING_DIM) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(collectionName)) {
    throw new Error(`Invalid Milvus collection name: ${collectionName}`);
  }
  if (!Number.isInteger(dim) || dim < 1) {
    throw new Error(`Invalid dense vector dimension: ${dim}`);
  }

  return {
    collection_name: collectionName,
    fields: [
      { name: 'id', data_type: DataType.VarChar, is_primary_key: true, max_length: 64 },
      {
        name: 'text',
        data_type: DataType.VarChar,
        max_length: 65535,
        enable_analyzer: true,
        analyzer_params: HYBRID_ANALYZER_PARAMS,
      },
      { name: 'dense_vector', data_type: DataType.FloatVector, dim },
      { name: 'sparse_vector', data_type: DataType.SparseFloatVector, is_function_output: true },
      { name: 'metadata', data_type: DataType.JSON },
      { name: 'knowledge_base_id', data_type: DataType.VarChar, max_length: 64 },
    ],
    functions: [
      {
        name: 'text_bm25',
        type: FunctionType.BM25,
        input_field_names: ['text'],
        output_field_names: ['sparse_vector'],
        params: {},
      },
    ],
  };
}

export function hybridCollectionIndexes(collectionName: string) {
  return [
    {
      collection_name: collectionName,
      field_name: 'dense_vector',
      index_type: 'AUTOINDEX',
      metric_type: 'COSINE',
    },
    {
      collection_name: collectionName,
      field_name: 'sparse_vector',
      index_type: 'SPARSE_INVERTED_INDEX',
      metric_type: 'BM25',
    },
  ];
}
