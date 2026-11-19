export function engineHost(){
  const view=chrome.extension.getViews().find(view=>view.OxMotion);
  if(!view)throw Error('Open this preview extension’s Control or AI Story panel, then start Motion Control from there.');
  return view.OxMotion;
}
