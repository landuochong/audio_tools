let cloneProfiles=[],clonePreviewURL=null;
function updateCloneControls(locked){
  for(const id of ['cloneName','cloneFile','cloneTranscript','cloneSave','cloneDelete'])$(id).disabled=locked;
  $('cloneTranscribe').disabled=locked||!$('cloneFile').files?.length;
  for(const id of ['clonePreview','savedVoiceAudio']){
    $(id).controls=!locked;if(locked)$(id).pause();
  }
}
function cloneMessage(text,error=false){$('cloneStatus').textContent=text;$('cloneStatus').classList.toggle('error',error);}
function showSavedVoice(){
  const profile=cloneProfiles.find(item=>'clone:'+item.id===currentVoice());
  $('savedVoice').hidden=!profile;
  $('savedVoiceAudio').pause();
  if(profile){
    $('savedVoiceInfo').textContent=`${profile.name} · ${profile.duration} 秒参考录音 · ${profile.reference_text}`;
    $('savedVoiceAudio').src=`/api/voices/${profile.id}/audio`;
  }else $('savedVoiceAudio').removeAttribute('src');
}
async function refreshVoices(selected=currentVoice()){
  const data=await api('/api/voices');cloneProfiles=data.voices;
  $('voiceMode').replaceChildren(new Option('原始克隆音色','clone'),new Option('低音耳语 · OmniVoice','low_whisper'),
    ...cloneProfiles.map(profile=>new Option(profile.name,'clone:'+profile.id)));
  $('voiceMode').value=[...$('voiceMode').options].some(option=>option.value===selected)?selected:'clone';
  showSavedVoice();updateVoiceMode();
}
const originalVoiceChange=$('voiceMode').onchange;
$('voiceMode').onchange=()=>{
  originalVoiceChange();showSavedVoice();
  try{localStorage.setItem('voice-tools-voice',currentVoice());}catch{}
};
$('cloneFile').onchange=()=>{
  if(clonePreviewURL)URL.revokeObjectURL(clonePreviewURL);
  const file=$('cloneFile').files[0];
  clonePreviewURL=file?URL.createObjectURL(file):null;
  $('clonePreview').hidden=!file;
  if(file)$('clonePreview').src=clonePreviewURL;else $('clonePreview').removeAttribute('src');
  // Never reuse a transcript from a different reference recording.
  $('cloneTranscript').value='';updateControls();
};
$('cloneTranscribe').onclick=async()=>{
  if(busy||recording||playing||autoSession?.pending||micStarting)return;
  const file=$('cloneFile').files[0];if(!file)return;
  busy=true;updateControls();cloneMessage('正在本机识别参考录音…');
  try{
    const body=new FormData();body.append('file',file);
    const data=await api('/api/transcribe',{method:'POST',body});
    $('cloneTranscript').value=data.text;
    cloneMessage('识别完成，请试听录音并核对原文后保存。');
  }catch(error){cloneMessage(error.message,true);}finally{busy=false;updateControls();}
};
$('cloneForm').onsubmit=async event=>{
  event.preventDefault();
  if(busy||recording||playing||autoSession?.pending||micStarting)return;
  const file=$('cloneFile').files[0];if(!file)return;
  if(file.size>20000000){cloneMessage('参考录音超过 20 MB，请先剪辑。',true);return;}
  const name=$('cloneName').value.trim(),text=$('cloneTranscript').value.trim();
  if(!name||!text){cloneMessage('请填写音色名称和参考录音的准确原文。',true);return;}
  busy=true;updateControls();cloneMessage('正在保存本地音色…');
  try{
    const body=new FormData();body.append('file',file);body.append('name',name);body.append('reference_text',text);
    const profile=await api('/api/voices',{method:'POST',body});
    await refreshVoices('clone:'+profile.id);
    try{localStorage.setItem('voice-tools-voice',currentVoice());}catch{}
    cloneMessage(`已保存并选用「${profile.name}」。输入文字即可试听克隆效果，也可用于 mic 和聊天建议。`);
  }catch(error){cloneMessage(error.message,true);}finally{busy=false;updateControls();}
};
$('cloneDelete').onclick=async()=>{
  if(busy||recording||playing||autoSession?.pending||micStarting)return;
  const profile=cloneProfiles.find(item=>'clone:'+item.id===currentVoice());
  if(!profile||!confirm(`删除音色「${profile.name}」及其参考录音？`))return;
  busy=true;updateControls();
  try{
    await api('/api/voices/'+profile.id,{method:'DELETE'});
    await refreshVoices('clone');
    try{localStorage.setItem('voice-tools-voice','clone');}catch{}
    cloneMessage('音色及其本地参考录音已删除。');
  }catch(error){cloneMessage(error.message,true);}finally{busy=false;updateControls();}
};
window.addEventListener('pagehide',()=>{if(clonePreviewURL)URL.revokeObjectURL(clonePreviewURL);});
let savedVoiceChoice='clone';try{savedVoiceChoice=localStorage.getItem('voice-tools-voice')||'clone';}catch{}
refreshVoices(savedVoiceChoice).catch(error=>cloneMessage(`加载音色失败：${error.message}`,true)).finally(updateControls);
