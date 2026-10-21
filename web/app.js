const $=id=>document.getElementById(id);
let autoSession=null,autoCapture=null,micStarting=false,micAttempt=0;
let chatContextEditing=false;
let clip=null,busy=false,recording=false,recorder=null,micStream=null,timer=null,seconds=0,playing=false,streaming=false;
async function api(path,options={}){const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'请求失败，请稍后再试。');return data;}
const post=(path,data)=>api(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function updateControls(){
  const pending=Boolean(autoSession?.pending),locked=busy||pending||micStarting;
  $('voiceMode').disabled=locked||recording;
  $('generate').disabled=locked||recording||chatContextEditing; $('streamGenerate').disabled=locked||recording||playing||chatContextEditing;
  $('play').disabled=!clip||locked||recording||playing;
  $('recordButton').disabled=!recording&&(locked||playing);
  $('suggestTab').disabled=recording||locked;
  for(const button of document.querySelectorAll('.use-suggestion'))button.disabled=recording||locked||playing;
  $('typeTab').disabled=recording||locked; $('recordTab').disabled=locked;
  for(const id of ['autoMode','autoConvert','micSelect','micRefresh','sensitivity'])$(id).disabled=recording||locked;
  $('queueStatus').textContent=pending?`还有 ${autoSession.pending} 句正在处理或排队；录音${recording?'持续进行':'已结束'}。`:'';
}
function currentVoice(){return $('voiceMode').value;}
function voiceName(voice){return voice==='low_whisper'?'低音耳语':'原始克隆音色';}
function updateVoiceMode(){const design=currentVoice()==='low_whisper';$('streamGenerate').textContent=design?'▶ 生成并播放':'▶ 边生成边播放';if(!busy)message(design?'低音耳语会在整句生成后自动播放；首次使用需要加载模型。':'已切换到原始克隆音色。');}
$('voiceMode').onchange=updateVoiceMode;
function count(){ $('count').textContent=$('text').value.length; }
$('text').addEventListener('input',count);
$('example').onclick=()=>{$('text').value='你好，我是露米。今天过得怎么样？如果有想说的话，我就在这里，慢慢听你说。';count();};
$('typeTab').onclick=()=>{$('suggestPanel').hidden=true;$('suggestTab').classList.remove('active');$('textPanel').open=true;$('textPanelToggle').hidden=true;$('recorder').hidden=true;$('typeTab').classList.add('active');$('recordTab').classList.remove('active');};
$('recordTab').onclick=()=>{$('suggestPanel').hidden=true;$('suggestTab').classList.remove('active');$('textPanel').open=false;$('textPanelToggle').hidden=false;$('recorder').hidden=false;$('recordTab').classList.add('active');$('typeTab').classList.remove('active');};
async function refreshMics(requestPermission=false){
  let temp;
  try{
    if(requestPermission)temp=await navigator.mediaDevices.getUserMedia({audio:true});
    const values=await navigator.mediaDevices.enumerateDevices();const old=$('micSelect').value;
    $('micSelect').replaceChildren(new Option('默认麦克风',''),...values.filter(d=>d.kind==='audioinput'&&d.deviceId!=='default').map((d,i)=>new Option(d.label||`麦克风 ${i+1}`,d.deviceId)));
    if([...$('micSelect').options].some(o=>o.value===old))$('micSelect').value=old;
  }catch{message('无法访问麦克风，请允许此网页使用麦克风，并检查系统隐私设置。',true);}finally{temp?.getTracks().forEach(t=>t.stop());}
}
$('micRefresh').onclick=()=>refreshMics(true);
async function refreshOutputs(){
  try{
    const {outputs}=await api('/api/devices');
    for(const [id,devices] of [['speakerSelect',outputs.filter(d=>!d.virtual)],['virtualSelect',outputs.filter(d=>d.virtual)]]){
      const select=$(id),old=select.value;
      select.replaceChildren(...devices.map(d=>new Option(d.name,String(d.id))));
      if(devices.some(d=>String(d.id)===old))select.value=old;
      else if(devices.some(d=>d.default))select.value=String(devices.find(d=>d.default).id);
      if(!devices.length)select.add(new Option(id==='virtualSelect'?'尚未检测到虚拟设备':'未检测到输出设备',''));
      select.disabled=!devices.length;
    }
    const hasVirtual=outputs.some(d=>d.virtual);
    $('virtualEnabled').disabled=!hasVirtual;
    if(!hasVirtual)$('virtualEnabled').checked=false;
    $('virtualHint').textContent=hasVirtual?'在聊天程序的麦克风设置中选择相同的虚拟设备。':'未检测到虚拟麦克风。安装 BlackHole 2ch 后重启工具。';
  }catch(error){message(error.message,true);}
}
$('refresh').onclick=refreshOutputs;
async function generate(){
  if(busy||recording||autoSession?.pending||chatContextEditing)return;
  const text=$('text').value.trim();if(!text){message('先输入文字或录一段声音。',true);return;}
  const voice=currentVoice();busy=true;updateControls();const started=Date.now();$('generate').textContent='正在合成…';message(`正在用${voiceName(voice)}合成，请稍等。`);
  const progress=setInterval(()=>message(`正在本机合成 · 已等待 ${Math.floor((Date.now()-started)/1000)} 秒`),1000);
  try{
    clip=await post('/api/synthesize',{text,voice});
    $('download').href=clip.url;$('download').setAttribute('download','voice-studio.wav');$('download').removeAttribute('aria-disabled');
    message('合成完成，可在底部重播或下载。');
  }catch(error){message(error.message,true);}finally{clearInterval(progress);busy=false;$('generate').textContent='✦ 只生成音频';updateControls();}
}
$('generate').onclick=generate;
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){e.preventDefault();generate();}});
$('play').onclick=async()=>{
  if(!clip||playing)return;
  const devices=[];
  if($('speakerEnabled').checked&&$('speakerSelect').value!=='')devices.push(Number($('speakerSelect').value));
  if($('virtualEnabled').checked&&$('virtualSelect').value!=='')devices.push(Number($('virtualSelect').value));
  if(!devices.length){message('请选择至少一个输出设备。',true);return;}
  try{await post('/api/play',{clip_id:clip.id,devices});playing=true;updateControls();message($('virtualEnabled').checked?'正在向虚拟麦克风输出克隆语音。':'正在通过所选扬声器播放。');}catch(error){message(error.message,true);}
};
$('stop').onclick=async()=>{micAttempt++;micStarting=false;if(autoSession){autoSession.cancelled=true;autoSession.asrQueue=[];autoSession.ttsQueue=[];autoSession.pending=0;autoSession.controller.abort();}if(autoCapture)await finishAuto(false);updateControls();try{await post('/api/stop',{});message(streaming?'已停止播放，正在取消后续生成…':'已停止播放。');}catch(error){message(error.message,true);}};
function finishRecording(){ if(recorder?.state==='recording')recorder.stop(); }
$('recordButton').onclick=async()=>{
  if(recording){if(autoCapture)await finishAuto(true);else finishRecording();return;}
  if(busy||playing||autoSession?.pending||micStarting)return;
  if($('autoMode').checked){await startAuto();return;}
  try{
    const device=$('micSelect').value;
    micStream=await navigator.mediaDevices.getUserMedia({audio:{...(device?{deviceId:{exact:device}}:{}),echoCancellation:true,noiseSuppression:true}});
    const mime=['audio/webm;codecs=opus','audio/mp4'].find(type=>MediaRecorder.isTypeSupported(type));
    recorder=new MediaRecorder(micStream,mime?{mimeType:mime}:{});const chunks=[];
    recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
    recorder.onstop=async()=>{
      clearInterval(timer);recording=false;micStream?.getTracks().forEach(t=>t.stop());micStream=null;
      $('bars').classList.remove('live');$('recordButton').textContent='● 开始录音';$('recordHint').textContent='录音完成，正在识别…';
      busy=true;updateControls();
      try{
        const blob=new Blob(chunks,{type:recorder.mimeType});const body=new FormData();body.append('file',blob,'recording');
        const data=await api('/api/transcribe',{method:'POST',body});
        if(!data.text.trim())throw new Error('没有识别到清晰人声，请重录。');
        if(data.text.length>500)message('识别文本超过 500 字，已截取前 500 字。',true);else message('识别完成，可以修改文字后再合成。');
        $('text').value=data.text.slice(0,500);count();
        busy=false;updateControls();if($('autoConvert').checked)await streamGenerate();
      }catch(error){message(error.message,true);}finally{busy=false;updateControls();$('recordHint').textContent='点击开始，说完后再点击结束';}
    };
    recorder.start(250);recording=true;seconds=0;updateControls();$('recordButton').textContent='■ 结束并识别';$('bars').classList.add('live');$('recordHint').textContent='正在录音，请说话';$('recordTime').textContent='00:00 / 01:00';
    timer=setInterval(()=>{seconds++;$('recordTime').textContent=`00:${String(seconds).padStart(2,'0')} / 01:00`;if(seconds>=60)finishRecording();},1000);
  }catch{micStream?.getTracks().forEach(t=>t.stop());message('录音启动失败，请允许麦克风权限并检查输入设备。',true);}
};
async function poll(){
  try{const state=await api('/api/status');$('ttsStatus').textContent=currentVoice()==='low_whisper'?(state.design?(state.design_loaded?'已就绪':'可用'):'未连接'):(state.tts?'已就绪':'加载中');$('asrStatus').textContent=state.asr?'本地识别已就绪':'识别服务未就绪';
    const wasPlaying=playing;playing=state.playback.active;
    if(wasPlaying&&!playing&&!streaming)message(state.playback.error||'播放完成。',Boolean(state.playback.error));updateControls();
  }catch{$('ttsStatus').textContent='未连接';}finally{setTimeout(poll,2000);}
}
window.addEventListener('pagehide',()=>{micStream?.getTracks().forEach(t=>t.stop());});
refreshOutputs();refreshMics();poll();

function selectedDevices(){
  const devices=[];
  if($('speakerEnabled').checked&&$('speakerSelect').value!=='')devices.push(Number($('speakerSelect').value));
  if($('virtualEnabled').checked&&$('virtualSelect').value!=='')devices.push(Number($('virtualSelect').value));
  return [...new Set(devices)];
}
async function streamGenerate(job=null){
  if(!job&&(busy||recording||playing||autoSession?.pending||chatContextEditing))return;
  const text=job?job.text:$('text').value.trim(),devices=job?job.devices:selectedDevices(),voice=job?.voice||currentVoice();
  if(!text||!devices.length){message('请输入文字，并选择至少一个输出设备。',true);return;}
  busy=true;streaming=true;updateControls();
  $('streamGenerate').textContent=voice==='low_whisper'?'正在生成整句…':'正在准备首段…';
  message(voice==='low_whisper'?'低音耳语正在本机生成，完成后自动播放。':'首段就绪后会直接向所选设备播放。');
  let completed=false;
  const historyVersion=typeof historyEpoch==='undefined'?null:historyEpoch;
  try{
    // Keep microphone capture independent of synthesis and playback. New speech
    // continues through ASR while the speech queue preserves playback order.
    const response=await fetch('/api/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,devices,voice})});
    if(!response.ok){const error=await response.json();throw new Error(typeof error.detail==='string'?error.detail:'流式请求失败');}
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
    while(true){
      const {value,done}=await reader.read();
      pending+=decoder.decode(value||new Uint8Array(),{stream:!done});
      let boundary;
      while((boundary=pending.indexOf('\n'))>=0){
        const line=pending.slice(0,boundary);pending=pending.slice(boundary+1);if(!line.trim())continue;
        const event=JSON.parse(line);
        if(event.type==='first_audio'){
          $('streamGenerate').textContent=voice==='low_whisper'?'正在播放…':'正在边生成边播放…';
          message(voice==='low_whisper'?`整句 ${event.seconds.toFixed(1)} 秒生成完成，正在播放。`:`首段 ${event.seconds.toFixed(1)} 秒就绪，缓冲后自动连续播放。`);
        }else if(event.type==='generated'){
          message('生成完成，正在播放剩余音频。');
        }else if(event.type==='done'){
          completed=true;clip=event;
          if(typeof appendSpokenHistory==='function')appendSpokenHistory(text,event.id,historyVersion);
          $('download').href=clip.url;$('download').setAttribute('download','voice-studio.wav');$('download').removeAttribute('aria-disabled');
          message(event.underflows?'播放完成。生成偶有跟不上播放的情况，可用「只生成音频」获得连续试听。':(voice==='low_whisper'?'播放完成，可重播或下载完整音频。':'流式播放完成，可重新播放或下载完整音频。'));
        }else if(event.type==='cancelled'){
          completed=true;message('已停止生成与播放。');
        }else if(event.type==='error')throw new Error(event.message);
      }
      if(done)break;
    }
    if(!completed)throw new Error('流式连接中断，请重试。');
  }catch(error){message(error.message,true);await post('/api/stop',{}).catch(()=>{});}
  finally{busy=false;streaming=false;playing=false;$('streamGenerate').textContent=voice==='low_whisper'?'▶ 生成并播放':'▶ 边生成边播放';updateControls();}
};
$('streamGenerate').onclick=()=>streamGenerate();
window.addEventListener('pagehide',()=>{if(streaming)navigator.sendBeacon('/api/stop','');});


$('autoMode').onchange=()=>{
  $('recordHint').textContent=$('autoMode').checked?'点击开始，停顿 2 秒自动处理，继续说话进入下一句':'点击开始，说完后点击结束';
  $('recordTime').textContent=$('autoMode').checked?'自动连续分句':'最长 60 秒';
};
async function startAuto(){
  const devices=selectedDevices(),convert=$('autoConvert').checked,voice=currentVoice();
  if(convert&&!devices.length){message('请先选择至少一个输出设备。',true);return;}
  if(typeof vad==='undefined'){message('本地人声检测未加载，请刷新页面。',true);return;}
  const attempt=++micAttempt;
  micStarting=true;updateControls();message('正在加载本地人声检测并启动麦克风…');
  const session={asrQueue:[],ttsQueue:[],asrRunning:false,ttsRunning:false,pending:0,cancelled:false,devices,convert,voice,number:0,controller:new AbortController()};
  const capture={vad:null,stream:null,stopping:false,discard:false,speaking:false,voicedFrames:0,rolling:false};
  const enqueue=pcm=>{
    if(session.cancelled||capture.discard||!pcm.length)return;
    session.asrQueue.push({blob:new Blob([pcmWav(pcm,16000)],{type:'audio/wav'}),number:++session.number});
    session.pending++;updateControls();drainRecognition(session);
    if(session.pending>=12&&!capture.stopping){message('待处理语音已达 12 句，已结束录音，正在依次处理。',true);finishAuto(false);}
  };
  try{
    const device=$('micSelect').value;
    const sensitivity=Number($('sensitivity').value);
    const detector=await vad.MicVAD.new({
      model:'v5',baseAssetPath:'/static/vendor/vad/',onnxWASMBasePath:'/static/vendor/vad/',
      ortConfig:ort=>{ort.env.logLevel='error';ort.env.wasm.numThreads=1;},
      positiveSpeechThreshold:sensitivity,negativeSpeechThreshold:Math.max(0.15,sensitivity-0.1),
      redemptionMs:2000,preSpeechPadMs:300,minSpeechMs:160,submitUserSpeechOnPause:true,
      getStream:async()=>{
        const stream=await navigator.mediaDevices.getUserMedia({audio:{...(device?{deviceId:{exact:device}}:{}),echoCancellation:true,noiseSuppression:true,channelCount:1}});
        if(attempt!==micAttempt){stream.getTracks().forEach(t=>t.stop());throw new Error('录音启动已取消');}
        capture.stream=stream;return stream;
      },
      // Keep the selected track open when a 55-second utterance rolls into the next batch.
      pauseStream:async()=>{},resumeStream:async stream=>stream,
      onSpeechStart:()=>{capture.speaking=true;capture.voicedFrames=0;},
      onVADMisfire:()=>{capture.speaking=false;capture.voicedFrames=0;},
      onSpeechEnd:audio=>{capture.speaking=false;capture.voicedFrames=0;enqueue(audio);},
      onFrameProcessed:(_probabilities,frame)=>{
        if(!capture.speaking||capture.stopping||capture.rolling)return;
        capture.voicedFrames+=frame.length;
        if(capture.voicedFrames>=55*16000){
          capture.rolling=true;
          (async()=>{
            try{await capture.vad.pause();if(!capture.stopping)await capture.vad.start();}
            catch(error){if(!capture.stopping){message(`人声检测中断：${error.message}`,true);await finishAuto(false);}}
            finally{capture.rolling=false;}
          })();
        }
      },
    });
    capture.vad=detector;
    if(attempt!==micAttempt){await detector.destroy();capture.stream?.getTracks().forEach(t=>t.stop());return;}
    autoSession=session;autoCapture=capture;micStream=capture.stream;
    recording=true;seconds=0;$('bars').classList.add('live');$('recordButton').textContent='■ 结束自动录音';
    $('recordHint').textContent='正在听 · 停顿 2 秒自动分句，处理时可以继续说';$('recordTime').textContent='00:00 · 连续录音';
    timer=setInterval(()=>{seconds++;$('recordTime').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')} · 连续录音`;},1000);
    capture.stream.getAudioTracks()[0].onended=()=>{if(!capture.stopping){message('麦克风已断开，正在处理已录入的语音。',true);finishAuto(true);}};
    message('自动模式已开始。检测到人声并停顿 2 秒后提交本句。');
  }catch(error){capture.stream?.getTracks().forEach(t=>t.stop());message(`自动录音启动失败：${error.message}`,true);}
  finally{if(attempt===micAttempt)micStarting=false;updateControls();}
}
async function finishAuto(submit){
  const capture=autoCapture;if(!capture||capture.stopping)return;
  capture.stopping=true;capture.discard=!submit;
  try{await capture.vad.destroy();}catch(error){message(`结束录音时出错：${error.message}`,true);}
  capture.discard=true;
  capture.stream?.getTracks().forEach(t=>t.stop());
  autoCapture=null;micStream=null;recording=false;clearInterval(timer);
  $('bars').classList.remove('live');$('recordButton').textContent='● 开始录音';
  $('recordHint').textContent='录音已结束，已提交的语音会继续依次处理';updateControls();
}
async function drainRecognition(session){
  if(session.asrRunning)return;session.asrRunning=true;
  try{
    while(session.asrQueue.length&&!session.cancelled){
      const job=session.asrQueue.shift();
      try{
        const body=new FormData();body.append('file',job.blob,'sentence.wav');
        const data=await api('/api/transcribe',{method:'POST',body,signal:session.controller.signal});
        if(session.cancelled)break;
        const text=data.text.trim();
        if(text){
          $('text').value=text.slice(0,500);count();
          if(session.convert){
            // Long recognition results are spoken in order, without silently truncating words.
            const texts=text.match(/[\s\S]{1,500}/g);
            session.pending+=texts.length-1;
            for(const part of texts)session.ttsQueue.push({text:part,devices:session.devices,voice:session.voice,autoSession:session});
            drainSpeech(session);
          }else{session.pending--;message(`第 ${job.number} 句识别完成。`);}
        }else{session.pending--;message(`第 ${job.number} 句未识别到文字，继续监听。`);}
      }catch(error){if(!session.cancelled){session.pending--;message(`第 ${job.number} 句识别失败：${error.message}`,true);}}
      updateControls();
    }
  }finally{session.asrRunning=false;updateControls();}
}
async function drainSpeech(session){
  if(session.ttsRunning)return;session.ttsRunning=true;
  try{
    while(session.ttsQueue.length&&!session.cancelled){
      const job=session.ttsQueue.shift();await streamGenerate(job);
      if(!session.cancelled)session.pending--;updateControls();
    }
  }finally{session.ttsRunning=false;updateControls();}
}
window.addEventListener('pagehide',()=>{if(autoSession){autoSession.cancelled=true;autoSession.controller.abort();}if(autoCapture){autoCapture.discard=true;autoCapture.vad.destroy().catch(()=>{});autoCapture.stream?.getTracks().forEach(t=>t.stop());}});
