(function(root){
  'use strict';
  const modes=['custom','name-asc','name-desc','newest','oldest'];
  function prepare(items){
    let added=Math.max(-1,...items.map(i=>Number.isFinite(i.addedOrder)?i.addedOrder:-1));
    let custom=Math.max(-1,...items.map(i=>Number.isFinite(i.customOrder)?i.customOrder:-1));
    for(const item of items){if(!Number.isFinite(item.addedOrder))item.addedOrder=++added;if(!Number.isFinite(item.customOrder))item.customOrder=++custom;}
  }
  function sort(items,mode){
    prepare(items);if(!modes.includes(mode))mode='custom';
    const name=(a,b)=>a.name.localeCompare(b.name,undefined,{numeric:true,sensitivity:'base'});
    const date=i=>Number.isFinite(i.lastModified)&&i.lastModified>0?i.lastModified:i.addedOrder;
    items.sort((a,b)=>{
      const diff=mode==='name-asc'?name(a,b):mode==='name-desc'?name(b,a):mode==='newest'?date(b)-date(a):mode==='oldest'?date(a)-date(b):a.customOrder-b.customOrder;
      return diff||a.addedOrder-b.addedOrder;
    });return items;
  }
  function move(items,from,to){
    if(!Number.isInteger(from)||!Number.isInteger(to)||from<0||to<0||from>=items.length||to>=items.length||from===to)return false;
    prepare(items);items.splice(to,0,items.splice(from,1)[0]);items.forEach((item,index)=>item.customOrder=index);return true;
  }
  const api={modes,prepare,sort,move};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.FlowImageOrder=api;
})(typeof self!=='undefined'?self:this);
