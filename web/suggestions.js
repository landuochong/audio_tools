let suggestionRequest=null,suggestionVersion=0,chatContext='',replyDraft='',historyEpoch=0;
const spokenClips=new Set();
function appendSpokenHistory(text,clipId,epoch){
  if(epoch!==historyEpoch||spokenClips.has(clipId)||!text.trim())return;
  spokenClips.add(clipId);
  if(spokenClips.size>100)spokenClips.delete(spokenClips.values().next().value);
  if(chatContextEditing)chatContext=$('text').value;
  const line='我：'+text.trim().replace(/\s*\n\s*/g,' ');
  chatContext=[chatContext.trimEnd(),line].filter(Boolean).join('\n');
  let trimmed=false;
  while(chatContext.length>6000){
    const boundary=chatContext.indexOf('\n');
    chatContext=boundary<0?chatContext.slice(-6000):chatContext.slice(boundary+1);trimmed=true;
  }
  if(chatContextEditing){$('text').value=chatContext;count();}
  $('suggestStatus').textContent=trimmed?'已记录刚才播放的话，较早记录已省略；下次建议会参考最近对话。':'已记录刚才播放的话，下次生成建议会参考这句。';
}
function editorMode(context){
  chatContextEditing=context;
  $('text').maxLength=context?6000:500;$('textLimit').textContent=context?'6000':'500';
  $('editorLabel').textContent=context?'聊天记录 / 对方刚说的话':'待播放回复';
  $('text').placeholder=context?'粘贴最近几句聊天，标明我 / 对方，或输入对方刚说的话。':'选好回复后，可以在这里修改，再播放。';
  $('example').hidden=!$('suggestPanel').hidden;
  document.querySelector('.generate-row').hidden=context;
  count();updateControls();
}
function saveEditor(){if(chatContextEditing)chatContext=$('text').value;else replyDraft=$('text').value;}
for(const id of ['typeTab','recordTab']){
  const original=$(id).onclick;
  $(id).onclick=()=>{if(!$('suggestPanel').hidden){saveEditor();$('text').value=replyDraft;}original();$('textPanelToggle').textContent='待转换文本 · 查看 / 修改';editorMode(false);$('editorLabel').textContent='待转换文本';};
}
$('suggestTab').onclick=()=>{
  if($('suggestPanel').hidden){replyDraft=$('text').value;$('text').value=chatContext;}else saveEditor();
  $('suggestPanel').hidden=false;$('recorder').hidden=true;editorMode(true);$('text').value=chatContext;count();
  $('textPanel').open=false;$('textPanelToggle').hidden=false;$('textPanelToggle').textContent='聊天记录（可选）· 展开 / 收起';
  $('suggestTab').classList.add('active');$('typeTab').classList.remove('active');$('recordTab').classList.remove('active');
};
async function checkSuggestions(){
  try{const state=await api('/api/suggestions/status');$('suggestStatus').textContent=state.ready?`本地 ${state.model} · 留空生成三句问候 · 点击一句直接播放`:state.message;}
  catch{$('suggestStatus').textContent='本地聊天服务未连接。';}
}
$('suggestButton').onclick=async()=>{
  if(suggestionRequest)return;
  saveEditor();const conversation=chatContext.trim();
  const version=++suggestionVersion,controller=new AbortController();suggestionRequest=controller;
  $('suggestButton').disabled=true;$('suggestButton').textContent='正在想怎么回应…';
  $('suggestStatus').textContent=conversation?'正在本机生成回复…':'正在生成三句自然的打招呼开场白…';
  try{
    const data=await api('/api/suggestions',{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,
      body:JSON.stringify({conversation,relationship:$('relationship').value,intention:$('intention').value.trim()})});
    if(version!==suggestionVersion)return;
    $('suggestions').replaceChildren();
    for(const suggestion of data.suggestions){
      const choose=document.createElement('button');choose.type='button';choose.className='suggestion-line use-suggestion';
      choose.textContent=suggestion.text;choose.title=`${suggestion.style} · 点击合成并播放`;
      choose.onclick=async()=>{
        if(busy||recording||playing||micStarting||autoSession?.pending)return;
        const devices=selectedDevices();
        if(!devices.length){message('请先选择扬声器或虚拟麦克风。',true);return;}
        for(const item of $('suggestions').children)item.classList.remove('selected');choose.classList.add('selected');
        replyDraft=suggestion.text;
        await streamGenerate({text:suggestion.text,devices,voice:currentVoice()});
      };
      $('suggestions').append(choose);
    }
    $('suggestStatus').textContent=`本地 ${data.model} · ${data.seconds.toFixed(1)} 秒 · 点击任意一句，直接合成并播放`;
    updateControls();
  }catch(error){if(error.name!=='AbortError'&&version===suggestionVersion)$('suggestStatus').textContent=error.message;}
  finally{if(version===suggestionVersion){suggestionRequest=null;$('suggestButton').disabled=false;$('suggestButton').textContent='↻ 再生成三条';}}
};
$('clearSuggestions').onclick=()=>{
  suggestionVersion++;suggestionRequest?.abort();suggestionRequest=null;
  historyEpoch++;spokenClips.clear();chatContext='';if(chatContextEditing){$('text').value='';count();}$('intention').value='';$('suggestions').replaceChildren();
  $('suggestButton').disabled=false;$('suggestButton').textContent='♡ 生成三条建议';
  $('suggestStatus').textContent='聊天记录和建议已清空。';
};
window.addEventListener('pagehide',()=>suggestionRequest?.abort());
checkSuggestions();
