import { readFile,writeFile } from 'node:fs/promises';
import { MilvusClient,RRFRanker,WeightedRanker } from '@zilliz/milvus2-sdk-node';
import { OpenAIEmbeddings } from '@langchain/openai';
const binding=JSON.parse(await readFile('reports/rag-baseline/hybrid-v1/binding.json','utf8'));
const client=new MilvusClient({address:`${process.env.MILVUS_HOST||'localhost'}:${process.env.MILVUS_PORT||19530}`,timeout:10000});
const embeddings=new OpenAIEmbeddings({modelName:'BAAI/bge-m3',openAIApiKey:process.env.OPENAI_API_KEY,configuration:{baseURL:process.env.OPENAI_BASE_URL},timeout:15000,maxRetries:0});
const configs=[['rrf60',RRFRanker(60)],['weighted70',WeightedRanker([0.7,0.3])],['weighted80',WeightedRanker([0.8,0.2])],['weighted90',WeightedRanker([0.9,0.1])]];
const rows=[];
try {
for(const q of binding.questions.filter(x=>x.split==='dev')){
 const v=await embeddings.embedQuery(q.query);const filter=`knowledge_base_id == "${binding.kb.id}"`;const row={id:q.id,noAnswer:q.noAnswer,modes:{}};
 for(const [name,rerank] of configs){
 const response=await client.hybridSearch({collection_name:binding.kb.collectionName,data:[{anns_field:'dense_vector',data:v,expr:filter},{anns_field:'sparse_vector',data:q.query,expr:filter}],rerank,limit:20,output_fields:['id','metadata']});
 if(response.status.error_code!=='Success')throw new Error(response.status.reason);
 const hits=response.results.slice(0,5).map((h,i)=>({rank:i+1,id:String(h.id),score:h.score}));
 row.modes[name]={hits,rank:hits.find(h=>q.relevantChunkIds.includes(h.id))?.rank||null,allEvidence:!q.noAnswer&&q.evidenceGroups.every(g=>hits.some(h=>g.relevantChunkIds.includes(h.id)))};
 }
 rows.push(row);console.log(q.id+' '+Object.entries(row.modes).map(([n,m])=>n+':'+(m.rank||'-')).join(' '));
}
const positives=rows.filter(x=>!x.noAnswer);const metrics={};for(const [name]of configs){metrics[name]={hitAt5:positives.filter(x=>x.modes[name].rank).length/positives.length,mrrAt5:positives.reduce((s,x)=>s+(x.modes[name].rank?1/x.modes[name].rank:0),0)/positives.length,allEvidenceAt5:positives.filter(x=>x.modes[name].allEvidence).length/positives.length};}
const path='reports/rag-baseline/hybrid-v1/fusion-experiment-dev.json';await writeFile(path,JSON.stringify({generatedAt:new Date().toISOString(),split:'dev',kbId:binding.kb.id,corpusFingerprint:binding.corpusFingerprint,configs:configs.map(([name,ranker])=>({name,ranker})),metrics,results:rows},null,2));console.log(JSON.stringify({path,metrics},null,2));
} finally {await client.closeConnection();}
