// Manual prompts have no AI Story speech field. Recover explicitly quoted speech,
// without treating quoted camera instructions, titles or signage as dialogue.
export function manualDialogue(prompt){
  let text=String(prompt||'');
  const timeline=text.search(/\bTIMELINE\b/i);
  if(timeline>=0)text=text.slice(timeline+8).split(/\n\s*(?:AUDIO|EXCLUDE|SAFETY)\s*[—:-]/i)[0];
  const lines=[];let previous=0;
  for(const match of text.matchAll(/["“]([^"“”]+)["”]/gu)){
    const context=text.slice(previous,match.index).slice(-240);previous=match.index+match[0].length;
    const spoken=/\b(?:says?|asks?|replies?|whispers?|shouts?|yells?|speaks?|narrates?|dialogue|narration|voice[ -]?over)\b[^"\n]{0,180}$/i.test(context);
    const named=/(?:^|\n)\s*[\p{Lu}][\p{L} .'-]{0,50}(?:\s*\([^\n)]{0,80}\))?\s*:\s*$/u.test(context);
    const instruction=/(?:\b(?:sign|screen|text|title|caption|label|poster|message)\s+(?:says?|reads?)\b[^\n]*|(?:^|\n)\s*(?:CAMERA|TITLE|TEXT|CAPTION|EXCLUDE|REFERENCES|STYLE|OUTPUT)\s*:\s*)$/i.test(context);
    if((spoken||named)&&!instruction){const line=match[1].replace(/\s+/g,' ').trim();if(line)lines.push(line);}
  }
  return lines.join(' ');
}
export function subtitleText(project,scene){
  return scene?.speech||scene?.caption||(project?.kind==='manual'?manualDialogue(scene?.videoPrompt):'');
}
