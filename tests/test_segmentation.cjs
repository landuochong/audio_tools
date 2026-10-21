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

test('spoken history preserves edited context, deduplicates clips and respects clear',()=>{
  const c=appSandbox();
  vm.runInContext(fs.readFileSync(require.resolve('../web/suggestions.js'),'utf8').replace(/checkSuggestions\(\);\s*$/,''),c);
  vm.runInContext(`chatContextEditing=true;$('text').value='对方：最近有点累。';appendSpokenHistory('辛苦了。','clip-1',historyEpoch);`,c);
  assert.equal(vm.runInContext('chatContext',c),'对方：最近有点累。\n我：辛苦了。');
  vm.runInContext(`appendSpokenHistory('辛苦了。','clip-1',historyEpoch);`,c);
  assert.equal(vm.runInContext('chatContext.split("\\n").length',c),2);
  vm.runInContext(`historyEpoch++;chatContext='';$('text').value='';appendSpokenHistory('迟到的播放','clip-2',historyEpoch-1);`,c);
  assert.equal(vm.runInContext('chatContext',c),'');
  vm.runInContext(`chatContextEditing=false;appendSpokenHistory('另一页播放','clip-3',historyEpoch);`,c);
  assert.equal(vm.runInContext('chatContext',c),'我：另一页播放');
});

test('stream only records successful playback, never cancellation or error',async()=>{
  for(const type of ['done','cancelled','error']){
    const c=appSandbox(),recorded=[];c.TextDecoder=TextDecoder;c.Uint8Array=Uint8Array;
    c.appendSpokenHistory=(...args)=>recorded.push(args);
    const download=c.document.getElementById('download');download.setAttribute=()=>{};download.removeAttribute=()=>{};
    c.fetch=async path=>{
      if(path==='/api/stop')return {ok:true,json:async()=>({})};
      let sent=false;return {ok:true,body:{getReader:()=>({read:async()=>{
        if(sent)return {done:true};sent=true;return {done:false,value:new TextEncoder().encode(JSON.stringify({type,id:'test-clip',message:'failed',url:'/api/audio/test'})+'\n')};
      }})}};
    };
    await vm.runInContext(`streamGenerate({text:'实际播放的话',devices:[2]})`,c);
    assert.equal(recorded.length,type==='done'?1:0);
    if(recorded.length)assert.equal(recorded[0][0],'实际播放的话');
  }
});

test('automatic microphone uses local VAD and queues detected speech at 16 kHz',async()=>{
  const c=appSandbox();
  c.setInterval=()=>1;c.clearInterval=()=>{};c.pcmWav=pcmWav;
  const track={stop(){}};
  const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  c.navigator.mediaDevices={getUserMedia:async()=>stream};
  c.vad={MicVAD:{new:async options=>{
    c.options=options;await options.getStream();
    return {destroy:async()=>{},pause:async()=>{},start:async()=>{}};
  }}};
  vm.runInContext('selectedDevices=()=>[1];drainRecognition=()=>{};',c);
  c.document.getElementById('sensitivity').value='0.35';
  await vm.runInContext('startAuto()',c);
  assert.equal(c.options.model,'v5');
  assert.equal(c.options.redemptionMs,2000);
  c.options.onSpeechEnd(new Float32Array(16000).fill(.1));
  const session=vm.runInContext('autoSession',c);
  assert.equal(session.asrQueue.length,1);
  const wav=new DataView(await session.asrQueue[0].blob.arrayBuffer());
  assert.equal(wav.getUint32(24,true),16000);
  await vm.runInContext('finishAuto(false)',c);
  c.options.onSpeechEnd(new Float32Array(16000).fill(.1));
  assert.equal(session.asrQueue.length,1);
});

test('ending automatic recording submits the final detected speech once',async()=>{
  const c=appSandbox();c.setInterval=()=>1;c.clearInterval=()=>{};c.pcmWav=pcmWav;
  const track={stop(){}};const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
  c.navigator.mediaDevices={getUserMedia:async()=>stream};
  c.vad={MicVAD:{new:async options=>{
    c.options=options;await options.getStream();
    return {destroy:async()=>options.onSpeechEnd(new Float32Array(3200).fill(.1))};
  }}};
  vm.runInContext('selectedDevices=()=>[1];drainRecognition=()=>{};',c);
  c.document.getElementById('sensitivity').value='0.35';
  await vm.runInContext('startAuto()',c);
  await vm.runInContext('finishAuto(true)',c);
  assert.equal(vm.runInContext('autoSession.asrQueue.length',c),1);
  await vm.runInContext('finishAuto(true)',c);
  assert.equal(vm.runInContext('autoSession.asrQueue.length',c),1);
});

for(const terminal of ['done','cancelled','error']){
  test(`microphone retains speech during synthesis and playback (${terminal})`,async()=>{
    const c=appSandbox();c.setInterval=()=>1;c.clearInterval=()=>{};
    c.TextDecoder=TextDecoder;c.Uint8Array=Uint8Array;c.pcmWav=pcmWav;
    let listening=true,pauses=0,resumes=0,stops=0;
    const track={stop(){stops++}};
    const stream={getTracks:()=>[track],getAudioTracks:()=>[track]};
    c.navigator.mediaDevices={getUserMedia:async()=>stream};
    c.vad={MicVAD:{new:async options=>{
      c.options=options;await options.getStream();
      return {
        pause:async()=>{listening=false;pauses++},
        start:async()=>{listening=true;resumes++},
        destroy:async()=>{listening=false;options.onSpeechEnd(new Float32Array(3200).fill(.3))},
      };
    }}};
    // Exercise actual VAD enqueue and ASR, holding the TTS queue for inspection.
    vm.runInContext('selectedDevices=()=>[1];drainSpeech=()=>{};',c);
    c.document.getElementById('autoConvert').checked=true;
    c.document.getElementById('sensitivity').value='0.35';
    const download=c.document.getElementById('download');download.setAttribute=()=>{};download.removeAttribute=()=>{};
    const heard=[];
    c.api=async(path,options)=>{
      if(path==='/api/transcribe'){
        const wav=new DataView(await options.body.get('file').arrayBuffer());
        heard.push(wav.getInt16(44,true));return {text:'句子'+heard.length};
      }
      return {};
    };
    await vm.runInContext('startAuto()',c);
    let beginPlayback,readEvent;
    c.fetch=()=>new Promise(resolve=>{beginPlayback=()=>resolve({ok:true,body:{getReader:()=>({
      read:()=>new Promise(resolve=>{readEvent=resolve}),
    })}})});
    const running=vm.runInContext("streamGenerate({text:'上一句',devices:[1],voice:'clone',autoSession})",c);
    const settle=()=>new Promise(resolve=>setImmediate(resolve));
    const speak=async value=>{
      assert.equal(listening,true);
      c.options.onSpeechEnd(new Float32Array(16000).fill(value));
      await settle();
    };
    // A new sentence while the stream request is still preparing audio.
    await speak(.1);
    beginPlayback();await settle();
    readEvent({done:false,value:new TextEncoder().encode(JSON.stringify({type:'first_audio',seconds:1})+'\n')});
    await settle();
    // Another sentence after playback starts, before it completes.
    await speak(.2);
    assert.equal(vm.runInContext('recording',c),true);
    assert.equal(stops,0);assert.equal(pauses,0);assert.equal(resumes,0);
    // Ending capture during playback still flushes the unfinished user phrase.
    await vm.runInContext('finishAuto(true)',c);await settle();
    assert.deepEqual(heard,[3277,6553,9830]);
    assert.deepEqual(Array.from(vm.runInContext('autoSession.ttsQueue.map(job=>job.text)',c)),['句子1','句子2','句子3']);
    assert.equal(vm.runInContext('autoSession.pending',c),3);
    readEvent({done:false,value:new TextEncoder().encode(JSON.stringify({type:terminal,id:'clip',url:'/api/audio/clip',message:'failed'})+'\n')});
    await settle();
    if(terminal!=='error')readEvent({done:true});
    await running;
    assert.equal(listening,false);assert.equal(stops,1);assert.equal(resumes,0);
  });
}

test('automatic microphone fixes the custom clone selection for every queued sentence',async()=>{
  const c=appSandbox(),spoken=[];
  c.streamGenerate=async job=>spoken.push({text:job.text,voice:job.voice});
  vm.runInContext(`
    globalThis.session={asrQueue:[{blob:new Blob(['one']),number:1},{blob:new Blob(['two']),number:2}],ttsQueue:[],asrRunning:false,ttsRunning:false,pending:2,cancelled:false,convert:true,devices:[2],voice:'clone:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',controller:new AbortController()};
    autoSession=session;
    $('voiceMode').value='low_whisper';
    api=async()=>({text:'自定义声音'});
  `,c);
  await vm.runInContext('drainRecognition(session)',c);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(spoken.length,2);
  assert.ok(spoken.every(job=>job.voice==='clone:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
});

test('streaming requests carry the selected custom clone instead of the default',async()=>{
  const c=appSandbox();c.TextDecoder=TextDecoder;c.Uint8Array=Uint8Array;
  const requests=[];
  c.fetch=async(path,options)=>{
    requests.push(JSON.parse(options.body));
    let sent=false;
    return {ok:true,body:{getReader:()=>({read:async()=>{
      if(sent)return {done:true};sent=true;
      return {done:false,value:new TextEncoder().encode('{"type":"cancelled"}\n')};
    }})}};
  };
  await vm.runInContext("streamGenerate({text:'测试音色',devices:[2],voice:'clone:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})",c);
  assert.equal(requests.length,1);
  assert.equal(requests[0].voice,'clone:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
});
