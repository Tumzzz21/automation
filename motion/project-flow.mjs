import {ensureFactoryFlowProject,factoryFlowPage} from '../lib/factory-flow-project.mjs';
import {flowProjectUrl} from './core.mjs';

// Resolve the destination before media upload. Persist the binding before each creation step.
export async function motionDestination(project,{tabs,inspect,save,sleep,check=()=>{},recover=false,maxPolls,click=null}={}){
  check();
  if(recover||['dispatching','submitted','collecting','needs_review'].includes(project.run?.phase)){
    if(!recover)throw Error('A submitted run needs recovery. Use Recover; no new project or video was created.');
    if(!project.run||project.run.phase==='completed')throw Error('There is no unfinished video to recover.');
    if(!['dispatching','submitted','collecting','needs_review'].includes(project.run.phase))throw Error('Auto has no submitted video to recover. For a manually generated clip, use Import a downloaded result in Prompt & manual tools. Use Reset preparation there to start a fresh Auto run.');
    let tab;try{tab=await tabs.get(project.run.tabId);}catch{throw Error('The original Flow tab is closed. Recovery cannot submit a new video. Your saved references are kept.');}
    if(flowProjectUrl(tab.url)!==project.run.url)throw Error('Return to the original Flow project before recovering. No new video was submitted.');
    return tab;
  }
  // An interrupted upload/fill belongs to its original page-side run state,
  // even if the destination picker has since selected another Flow tab.
  if(/^uploading |^filling prompt$/.test(project.run?.phase||'')){
    let tab;try{tab=await tabs.get(project.run.tabId);}catch{throw Error('The setup tab is closed. Use Reset preparation to keep your references and prepare a fresh run.');}
    if(flowProjectUrl(tab.url)!==project.run.url)throw Error('The setup tab changed project. Return to it, or use Reset preparation before starting a fresh run.');
    return tab;
  }
  if(project.flowMode==='existing'){
    const tab=await tabs.get(project.flowTabId);const url=flowProjectUrl(tab.url);
    if(project.flowUrl&&url!==project.flowUrl)throw Error('The selected Flow project changed. Select it again before generating.');
    project.flowUrl=url;await save();return tab;
  }
  const story={projectId:project.id,flowProjects:project.flowProjects||{}};
  const factory={stories:[story]};
  try{
    return await ensureFactoryFlowProject(factory,0,{tabs,inspect,sleep,maxPolls,click,assertActive:check,save:async()=>{project.flowProjects=story.flowProjects;await save();}});
  }catch(error){
    if(/left Google Flow/.test(error.message))throw Error('Sign in to Flow in the opened tab, then click Generate again. No video was submitted.');
    throw Error(error.message.replaceAll('Factory','Motion Control').replaceAll('this part','this study'));
  }
}
export async function inspectMotionDestination(tabId){
  const result=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:factoryFlowPage,args:[]});
  return result[0]?.result;
}
