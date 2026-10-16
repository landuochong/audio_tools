const $=id=>document.getElementById(id);
let clip=null,busy=false,recording=false,recorder=null,micStream=null,timer=null,seconds=0,playing=false,streaming=false;
async function api(path,options={}){const response=await fetch(path,options);const data=await response.json();if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:'请求失败，请稍后再试。');return data;}
const post=(path,data)=>api(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function updateControls(){ $('generate').disabled=busy||recording; $('streamGenerate').disabled=busy||recording||playing; $('play').disabled=!clip||busy||recording||playing; $('recordButton').disabled=busy||playing; $('typeTab').disabled=recording||busy; $('recordTab').disabled=busy; }
function count(){ $('count').textContent=$('text').value.length; }
$('text').addEventListener('input',count);
$('example').onclick=()=>{$('text').value='你好，我是露米。今天过得怎么样？如果有想说的话，我就在这里，慢慢听你说。';count();};
$('typeTab').onclick=()=>{$('textPanel').open=true;$('textPanelToggle').hidden=true;$('recorder').hidden=true;$('typeTab').classList.add('active');$('recordTab').classList.remove('active');};
$('recordTab').onclick=()=>{$('textPanel').open=false;$('textPanelToggle').hidden=false;$('recorder').hidden=false;$('recordTab').classList.add('active');$('typeTab').classList.remove('active');};
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
  if(busy||recording)return;
  const text=$('text').value.trim();if(!text){message('先输入文字或录一段声音。',true);return;}
  busy=true;updateControls();const started=Date.now();$('generate').textContent='正在合成…';message('正在用原始克隆音色合成，请稍等。');
  const progress=setInterval(()=>message(`正在本机合成 · 已等待 ${Math.floor((Date.now()-started)/1000)} 秒`),1000);
  try{
    clip=await post('/api/synthesize',{text});
    $('duration').textContent=`${clip.duration.toFixed(1)} 秒`;
    $('clipInfo').textContent=`已生成 · 耗时 ${clip.seconds.toFixed(1)} 秒 · 原速`;
    $('download').href=clip.url;$('download').hidden=false;
    message('合成完成。选择声音去向，再点击播放。');
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
$('stop').onclick=async()=>{try{await post('/api/stop',{});message(streaming?'已停止播放，正在取消后续生成…':'已停止播放。');}catch(error){message(error.message,true);}};
function finishRecording(){ if(recorder?.state==='recording')recorder.stop(); }
$('recordButton').onclick=async()=>{
  if(recording){finishRecording();return;}
  if(busy||playing)return;
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
  try{const state=await api('/api/status');$('ttsStatus').textContent=state.tts?'已就绪':'加载中';$('asrStatus').textContent=state.asr?'本地识别已就绪':'识别服务未就绪';
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
async function streamGenerate(){
  if(busy||recording||playing)return;
  const text=$('text').value.trim(),devices=selectedDevices();
  if(!text||!devices.length){message('请输入文字，并选择至少一个输出设备。',true);return;}
  busy=true;streaming=true;updateControls();
  $('streamGenerate').textContent='正在准备首段…';
  message('首段就绪后会直接向所选设备播放。');
  let completed=false;
  try{
    const response=await fetch('/api/stream',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,devices})});
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
          $('streamGenerate').textContent='正在边生成边播放…';
          message(`首段 ${event.seconds.toFixed(1)} 秒就绪，缓冲后自动连续播放。`);
        }else if(event.type==='generated'){
          message('生成完成，正在播放剩余音频。');
        }else if(event.type==='done'){
          completed=true;clip=event;
          $('duration').textContent=`${clip.duration.toFixed(1)} 秒`;
          $('clipInfo').textContent=`开口 ${Number(clip.first_play_seconds ?? clip.first_audio_seconds).toFixed(1)} 秒 · 全部生成 ${clip.seconds.toFixed(1)} 秒`;
          $('download').href=clip.url;$('download').hidden=false;
          message(event.underflows?'播放完成。生成偶有跟不上播放的情况，可用「只生成音频」获得连续试听。':'流式播放完成，可重新播放或下载完整音频。');
        }else if(event.type==='cancelled'){
          completed=true;message('已停止生成与播放。');
        }else if(event.type==='error')throw new Error(event.message);
      }
      if(done)break;
    }
    if(!completed)throw new Error('流式连接中断，请重试。');
  }catch(error){message(error.message,true);await post('/api/stop',{}).catch(()=>{});}
  finally{busy=false;streaming=false;$('streamGenerate').textContent='▶ 边生成边播放';updateControls();}
};
$('streamGenerate').onclick=streamGenerate;
window.addEventListener('pagehide',()=>{if(streaming)navigator.sendBeacon('/api/stop','');});
