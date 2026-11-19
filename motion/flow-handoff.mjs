// Runs only after the lab's explicit prepare action. No uploads or generation clicks.
export function openNativePicker({expectedUrl}) {
  if (location.href !== expectedUrl) return {ok:false,error:'Flow navigated to another page. Refresh projects.'};
  const matches=[...document.querySelectorAll('button')].filter(el=>el.getClientRects().length && /add ingredients to the prompt box/i.test(el.getAttribute('aria-label')||''));
  if(matches.length!==1)return {ok:false,error:'In Flow, choose Video → Ingredients, close settings, then click Attach references in Flow again.'};
  const button=matches[0];
  if(button.getAttribute('aria-expanded')!=='true')button.click();
  return {ok:true,message:'In Flow’s picker, click Upload media and select your source video and character image. Add each to the prompt. Then return here and click Check references & fill prompt.'};
}
export function prepareNativeFlow({expectedUrl, prompt, filenames}) {
  if (location.href !== expectedUrl) return {ok:false, error:'Flow navigated to another page. Refresh projects.'};
  const visible = el => !!(el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const inputs = [...document.querySelectorAll('[contenteditable="true"],textarea')].filter(el => visible(el) && /what do you want to create/i.test(el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || el.getAttribute('placeholder') || ''));
  if (inputs.length !== 1) return {ok:false,error:'Open the Flow composer and close other dialogs first.'};
  const input = inputs[0];
  if ((input.value ?? input.innerText ?? '').trim()) return {ok:false,error:'The Flow composer already contains text. Keep or clear it yourself before preparing.'};
  // Restrict attachment evidence to the composer, excluding the project gallery.
  let composer = input.parentElement;
  for (let i=0; composer && i<7; i++, composer=composer.parentElement) {
    const buttons=[...composer.querySelectorAll('button')];
    if (buttons.some(b => /add ingredients to the prompt box/i.test(b.getAttribute('aria-label') || ''))) break;
  }
  if (!composer || composer.querySelector('main') || composer.querySelector('[role="list"]')) return {ok:false,error:'Choose Video → Ingredients in Flow. The reference-video input must be available.'};
  const labels=[...composer.querySelectorAll('[aria-label],[title],img')].flatMap(el=>[el.getAttribute('aria-label'),el.getAttribute('title'),el.getAttribute('alt')]).filter(Boolean);
  const missing=filenames.filter(name=>!labels.some(label=>label===name || label.includes(name)));
  if (missing.length) return {ok:false,error:`Add these files through Flow’s Ingredients picker first: ${missing.join(', ')}. The lab could not verify them in the composer.`};
  input.focus();
  let changed=false;
  if (input.tagName==='TEXTAREA') {
    const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
    setter.call(input,prompt); input.dispatchEvent(new Event('input',{bubbles:true})); changed=true;
  } else {
    changed=document.execCommand('insertText',false,prompt);
  }
  const filled=(input.value ?? input.innerText ?? '').trim();
  if (!changed || filled!==prompt.trim()) return {ok:false,error:'Flow did not accept the complete prompt. Copy the prompt from the lab and paste it manually.'};
  return {ok:true,message:'References checked and prompt filled. Review Flow settings and press Generate when ready.'};
}
