const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {SilenceSegmenter,pcmWav}=require('../web/segmentation.js');
const rate=1000,voice=n=>new Float32Array(n).fill(.1),quiet=n=>new Float32Array(n);
test('silence alone never emits; speech emits only after two silent seconds',()=>{
  const clips=[],s=new SilenceSegmenter(rate,x=>clips.push(x));
  s.push(quiet(10000));assert.equal(clips.length,0);
  s.push(voice(500));s.push(quiet(1990));assert.equal(clips.length,0);
  s.push(quiet(10));assert.equal(clips.length,1);assert.equal(clips[0].length,2750);
  s.push(quiet(5000));assert.equal(clips.length,1);
});
test('speech after cutoff belongs exclusively to next batch',()=>{
  const clips=[],s=new SilenceSegmenter(rate,x=>clips.push(x));
  const input=new Float32Array(5000);input.set(voice(500));input.set(new Float32Array(500).fill(.2),2500);
  s.push(input);assert.equal(clips.length,2);
  assert.equal(clips[0].length,2500);assert.equal(clips[1].length,2500);
  assert.equal(clips[0][0],Math.fround(.1));assert.equal(clips[1][0],Math.fround(.2));
});
test('short pause resets silence countdown when speech resumes',()=>{
  const clips=[],s=new SilenceSegmenter(rate,x=>clips.push(x));
  s.push(voice(500));s.push(quiet(1900));s.push(voice(200));s.push(quiet(1990));assert.equal(clips.length,0);
  s.push(quiet(10));assert.equal(clips.length,1);
});
test('stop flushes remaining speech once; clicks and silence are ignored',()=>{
  const clips=[],s=new SilenceSegmenter(rate,x=>clips.push(x));
  s.push(voice(20));s.push(quiet(2000));assert.equal(clips.length,0);
  s.push(voice(500));s.flush();s.flush();assert.equal(clips.length,1);
});
test('maximum length splits continuous speech without losing or repeating samples',()=>{
  const clips=[],s=new SilenceSegmenter(rate,x=>clips.push(x),{maxSeconds:3});
  s.push(voice(7500));s.flush();assert.deepEqual(clips.map(x=>x.length),[3000,3000,1500]);
});
test('WAV retains sample rate, length and signed PCM',()=>{
  const view=new DataView(pcmWav(new Float32Array([-1,0,1]),48000));
  assert.equal(view.getUint32(24,true),48000);assert.equal(view.getUint32(40,true),6);
  assert.equal(view.getInt16(44,true),-32768);assert.equal(view.getInt16(48,true),32767);
});
test('worklet preserves packets and partial final buffer on stop',()=>{
  const messages=[];let Processor;
  const sandbox={AudioWorkletProcessor:class{constructor(){this.port={postMessage:x=>messages.push(x)};}},registerProcessor:(_,p)=>Processor=p};
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/mic-worklet.js'),'utf8'),sandbox);
  const p=new Processor();for(let n=0;n<9;n++)p.process([[new Float32Array(128).fill(n)]]);
  p.port.onmessage({data:'stop'});assert.deepEqual(messages.map(x=>typeof x==='string'?x:x.length),[1024,128,'stopped']);
  assert.equal(messages[0][1023],7);assert.equal(messages[1][0],8);assert.equal(p.process([]),false);
});
function appSandbox(){
  const nodes=new Map();const element=()=>({value:'',checked:false,disabled:false,textContent:'',classList:{toggle(){},add(){},remove(){}},addEventListener(){}});
  const context=vm.createContext({document:{querySelectorAll:()=>[],getElementById:id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);},addEventListener(){}},window:{addEventListener(){}},navigator:{},FormData,Blob,AbortController,console,setTimeout,clearTimeout});
  const code=fs.readFileSync(require.resolve('../web/app.js'),'utf8').replace('refreshOutputs();refreshMics();poll();','');
  vm.runInContext(code,context);return context;
}
test('ASR proceeds during earlier TTS, speech queue stays FIFO, recording stays active',async()=>{
  const c=appSandbox();
  vm.runInContext(`
    globalThis.heard=[];globalThis.spoken=[];globalThis.releases=[];
    api=async()=>({text:'句子'+(heard.push(1))});
    streamGenerate=job=>new Promise(resolve=>{spoken.push(job.text);releases.push(resolve);});
    recording=true;
    globalThis.session={asrQueue:[{blob:new Blob(['one']),number:1},{blob:new Blob(['two']),number:2}],ttsQueue:[],asrRunning:false,ttsRunning:false,pending:2,cancelled:false,convert:true,devices:[2],controller:new AbortController()};
    autoSession=session;
  `,c);
  await vm.runInContext('drainRecognition(session)',c);
  assert.equal(c.heard.length,2);assert.deepEqual(Array.from(c.spoken),['句子1']);assert.equal(vm.runInContext('recording',c),true);
  c.releases.shift()();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(Array.from(c.spoken),['句子1','句子2']);
  c.releases.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(c.session.pending,0);
});
test('cancel during ASR never queues or plays late recognition',async()=>{
  const c=appSandbox();
  vm.runInContext(`
    api=()=>new Promise(resolve=>globalThis.complete=resolve);
    globalThis.session={asrQueue:[{blob:new Blob(['one']),number:1}],ttsQueue:[],asrRunning:false,ttsRunning:false,pending:1,cancelled:false,convert:true,devices:[2],controller:new AbortController()};autoSession=session;
  `,c);
  const running=vm.runInContext('drainRecognition(session)',c);c.session.cancelled=true;c.session.pending=0;c.complete({text:'不能播放'});await running;
  assert.equal(c.session.ttsQueue.length,0);assert.equal(c.session.pending,0);
});
