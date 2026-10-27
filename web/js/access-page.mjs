const form=document.getElementById('access-form'),button=document.getElementById('access-submit'),input=document.getElementById('access-password'),message=document.getElementById('access-message');
form.addEventListener('submit',async event=>{
 event.preventDefault();if(button.disabled)return;button.disabled=true;message.textContent='확인하고 있어요.';
 try{
  const response=await fetch('/api/session/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',redirect:'error',body:JSON.stringify({password:input.value})});
  input.value='';
  if(response.ok){location.reload();return;} // Reload keeps result link fragments out of the login request.
  message.textContent=response.status===429?'여러 번 확인에 실패했어요. 잠시 후 다시 시도해 주세요.':response.status===401?'비밀번호를 다시 확인해 주세요.':'연결을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.';
 }catch{message.textContent='연결이 잠시 끊겼어요. 다시 시도해 주세요.';}
 finally{button.disabled=false;input.focus();}
});
