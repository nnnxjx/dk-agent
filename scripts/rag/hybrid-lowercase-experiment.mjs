import { readFile,writeFile } from 'node:fs/promises';
import {createRequire} from 'node:module';
import {MilvusClient,RRFRanker} from '@zilliz/milvus2-sdk-node';
import {OpenAIEmbeddings} from '@langchain/openai';
const require=createRequire(import.meta.url);require('ts-node/register/transpile-only');
const {hybridCollectionSchema,hybridCollectionIndexes}=require('../../src/rag/hybrid-collection.schema.ts');
const binding=JSON.parse(await readFile('reports/rag-baseline/step1-single-kb/hybrid-v1/binding.json','utf8'));
const client=new MilvusClient({address:`${process.env.MILVUS_HOST||'localhost'}:${process.env.MILVUS_PORT||19530}`,timeout:20000});
const analyzer={tokenizer:'jieba',filter:['cnalphanumonly','lowercase']};
const tempName='eval_lowercase_'+Date.now();let created=false;
function ok(r){if(r.status?.error_code!=='Success'&&r.error_code!=='Success')throw new Error(r.status?.reason||r.reason||'Milvus operation failed');return r;}
const embed=new OpenAIEmbeddings({modelName:'BAAI/bge-m3',openAIApiKey:process.env.OPENAI_API_KEY,configuration:{baseURL:process.env.OPENAI_BASE_URL},timeout:15000,maxRetries:0});
const report={generatedAt:new Date().toISOString(),mode:'hybrid',split:'dev',sourceCollection:binding.kb.collectionName,temporaryCollection:tempName,analyzer,corpusFingerprint:binding.corpusFingerprint,results:[],metrics:{}};
try {
const tokens=ok(await client.runAnalyzer({analyzer_params:analyzer,text:['embedding','Embedding','EMBEDDING'],with_detail:true}));report.caseTokens=tokens.results.map(r=>r.tokens.map(t=>t.token));
if(!report.caseTokens.every(tokens=>JSON.stringify(tokens)===JSON.stringify(['embedding'])))throw new Error('Case normalization test failed');
const filter=`knowledge_base_id == "${binding.kb.id}"`;
const data=ok(await client.query({collection_name:binding.kb.collectionName,filter,output_fields:['id','text','metadata','dense_vector','knowledge_base_id'],limit:10000})).data;
if(data.length!==binding.chunkCount)throw new Error('Source chunk count changed');
const schema=hybridCollectionSchema(tempName);schema.fields.find(f=>f.name==='text').analyzer_params=analyzer;
ok(await client.createCollection(schema));created=true;
for(const index of hybridCollectionIndexes(tempName))ok(await client.createIndex(index));
ok(await client.insert({collection_name:tempName,data}));ok(await client.flushSync({collection_names:[tempName]}));ok(await client.loadCollectionSync({collection_name:tempName}));
for(const q of binding.questions.filter(q=>q.split==='dev')){
const vector=await embed.embedQuery(q.query);const row={id:q.id,noAnswer:q.noAnswer,modes:{}};
for(const [name,collection]of [['original',binding.kb.collectionName],['lowercase',tempName]]){
const response=ok(await client.hybridSearch({collection_name:collection,data:[{anns_field:'dense_vector',data:vector,expr:filter},{anns_field:'sparse_vector',data:q.query,expr:filter}],rerank:RRFRanker(60),limit:20,output_fields:['id']}));
const hits=response.results.slice(0,5).map(h=>String(h.id));row.modes[name]={hits,rank:hits.findIndex(id=>q.relevantChunkIds.includes(id))+1||null,allEvidence:!q.noAnswer&&q.evidenceGroups.every(g=>hits.some(id=>g.relevantChunkIds.includes(id)))};
}
report.results.push(row);console.log(q.id+' original='+(row.modes.original.rank||'-')+' lowercase='+(row.modes.lowercase.rank||'-'));
}
const positives=report.results.filter(r=>!r.noAnswer);for(const mode of ['original','lowercase'])report.metrics[mode]={hitAt5:positives.filter(r=>r.modes[mode].rank).length/positives.length,mrrAt5:positives.reduce((sum,r)=>sum+(r.modes[mode].rank?1/r.modes[mode].rank:0),0)/positives.length,allEvidenceAt5:positives.filter(r=>r.modes[mode].allEvidence).length/positives.length};
await writeFile('reports/rag-baseline/step1-single-kb/hybrid-v1/lowercase-experiment-dev.json',JSON.stringify(report,null,2));console.log(JSON.stringify({metrics:report.metrics},null,2));
}finally{if(created){ok(await client.dropCollection({collection_name:tempName}));console.log('Removed own temporary collection: '+tempName);}await client.closeConnection();}
