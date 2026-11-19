(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.FacelessBuilder = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const VERSION = 1;
  // 58 AI Drama (owner 2026-10-30): the Tagalog Drama engine for any country and language (storyCulture).
  // 61 Anime Drama (owner 2026-11-08): the AI Drama engine (any country and language) drawn as a warm golden 2D anime
  // storybook film; the look is fixed (ANIME_DRAMA_LOOK), the story country works as in AI Drama.
  const isDrama=n=>[34,36,37,38,39,40,58,61].includes(Number(n));
  const isWorldDrama=n=>[58,61].includes(Number(n));
  // Anime Drama v2 (owner 2026-11-08): what kind of story; Auto lets the topic decide. Missing = Auto (drafts made before v2).
  const ANIME_STORIES=['Auto','Everyday drama','Folk tale','Fantasy adventure','Original fantasy world'];
  const ANIME_DRAMA_LOOK='hand-painted 2D anime storybook illustration (clean ink line art, soft cel shading with painted gradients, large expressive anime eyes and strongly readable emotions, richly painted detailed backgrounds, warm golden glowing light with soft sparkles and bokeh, saturated warm colors with magenta and violet accents; not a photograph, not photorealistic, not 3D)';
  const LANGUAGES=['English','Tagalog','English and Tagalog','Spanish','Portuguese','French','German','Vietnamese','Indonesian','Thai','Hindi','Korean','Japanese','Chinese (Mandarin)','Arabic','Bangla','Urdu','Romanian','Custom'];
  // Tagalog Drama is always set in the Philippines, so its language list keeps to Tagalog and English (owner 2026-10-30);
  // other languages belong to AI Drama, which moves the story to the language's country. Display only: validation keeps LANGUAGES.
  const TAGALOG_DRAMA_LANGUAGES=['Tagalog','English and Tagalog','English'];
  const languagesFor=niche=>Number(niche)===34?TAGALOG_DRAMA_LANGUAGES:LANGUAGES;
  const DRAMA_COUNTRIES=['Auto (match the language)','United States','United Kingdom','Mexico','Spain','Brazil','France','Germany','Vietnam','Indonesia','Thailand','India','South Korea','Japan','China','Egypt','Nigeria','Philippines','Bangladesh','Pakistan','Romania','Custom'];
  const LANGUAGE_COUNTRY={English:'United States',Tagalog:'Philippines','English and Tagalog':'Philippines',Spanish:'Mexico',Portuguese:'Brazil',French:'France',German:'Germany',Vietnamese:'Vietnam',Indonesian:'Indonesia',Thai:'Thailand',Hindi:'India',Korean:'South Korea',Japanese:'Japan','Chinese (Mandarin)':'China',Arabic:'Egypt',Bangla:'Bangladesh',Urdu:'Pakistan',Romanian:'Romania'};
  // Picking a country switches the viewer language to its main one (owner 2026-10-30); the user may change it again after.
  const COUNTRY_LANGUAGE={'United States':'English','United Kingdom':'English',Mexico:'Spanish',Spain:'Spanish',Brazil:'Portuguese',France:'French',Germany:'German',Vietnam:'Vietnamese',Indonesia:'Indonesian',Thailand:'Thai',India:'Hindi','South Korea':'Korean',Japan:'Japanese',China:'Chinese (Mandarin)',Egypt:'Arabic',Nigeria:'English',Philippines:'Tagalog',Bangladesh:'Bangla',Pakistan:'Urdu',Romania:'Romanian'};
  const countryLanguage=country=>COUNTRY_LANGUAGE[country]||null;
  // Keep the new named choice compatible with servers that already accept Custom languages/countries.
  const compatibleLanguageSetup=a=>!a||a.language!=='Romanian'&&a.dramaCountry!=='Romania'?a:({...a,...(a.language==='Romanian'?{language:'Custom',customLanguage:'Romanian'}:{}),...(a.dramaCountry==='Romania'?{dramaCountry:'Custom',customCountry:'Romania'}:{})});

  // Thai, Lao, Khmer, Burmese, Chinese and Japanese are written without spaces between words. Owner's Thai AI Drama test
  // (2026-10-30): the AI spaced every Thai word ("พี่ ซ่อน ใบหนี้ ของ แม่") so the words could be counted. Their letters now
  // count as word-equivalents (about 2.5 Thai consonants, 1.5 Chinese characters or 2.5 kana per word).
  const HAN=/[㐀-鿿豈-﫿]/g,KANA=/[぀-ヿ]/g,SEA=/[ก-ฮກ-ຮက-ဪក-ឳ]/g;
  const NO_SPACE=/[฀-໿က-႟ក-៿぀-ヿ㐀-鿿豈-﫿]/,CJK=/[぀-ヿ㐀-鿿豈-﫿]/;
  // Existing script (member report 2026-11-04): a pasted screenplay has "Scene 1" headings, "MARIA:" speaker labels and
  // (directions) that are not spoken, so the AI rightly leaves them out of the speech. Only the spoken words are compared,
  // by letters and numbers (punctuation, capitals and spacing may differ).
  const SCRIPT_HEADING=/^\s*(?:(?:scene|eksena|shot|part|bahagi)\s*(?:\d+|[ivx]+)\b|int\.|ext\.).*$/iu;
  const SPEAKER_LABEL=/^\s*[\p{L}\p{M}](?:[\p{L}\p{M}\p{N} .'’-]{0,28}[\p{L}\p{M}.])?\s*(?:\([^)]{0,40}\))?\s*:(?!\d)\s*/u;
  function spokenScript(text){
    return String(text||'').split(/\r?\n/).filter(l=>!SCRIPT_HEADING.test(l)).map(l=>l.replace(SPEAKER_LABEL,'').replace(/\([^)]*\)|\[[^\]]*\]/g,' ')).join(' ').replace(/\s+/g,' ').trim();
  }
  const scriptLetters=t=>String(t||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu,'');
  function sameScript(speeches,script){
    const said=speeches.join(' ').replace(/\s+/g,' ').trim();
    if(said===String(script||'').replace(/\s+/g,' ').trim())return true;
    // Speaker names from the script's labels, also removed when the AI wrote them inside a scene's speech ("... Niko: Opo").
    const names=new Set(String(script||'').split(/\r?\n/).map(l=>(l.match(SPEAKER_LABEL)||[''])[0].replace(/\([^)]*\)|:/g,'').replace(/\s+/g,' ').trim().toLowerCase()).filter(Boolean));
    const unlabel=t=>{
      const parts=spokenScript(t).split(':');
      return parts.map((seg,i)=>{
        if(i===parts.length-1)return seg;
        const w=seg.trim().split(/\s+/);
        for(let k=1;k<=4&&k<=w.length;k++)if(names.has(w.slice(-k).join(' ').toLowerCase()))return w.slice(0,-k).join(' ');
        return seg;
      }).join(' ');
    };
    return scriptLetters(speeches.map(unlabel).join(' '))===scriptLetters(spokenScript(script));
  }
  function spokenWords(text){
    let n=0;for(const token of String(text||'').trim().split(/\s+/).filter(Boolean)){const han=(token.match(HAN)||[]).length,kana=(token.match(KANA)||[]).length,sea=(token.match(SEA)||[]).length;n+=han||kana||sea?Math.max(1,Math.round(han/1.5+kana/2.5+sea/2.5)):1;}
    return n;
  }
  // Removes the spaces an AI put between single words of those scripts. Chinese and Japanese never use spaces; Thai-type
  // scripts keep spaces between phrases, so they are joined only when the line is spaced word by word (short pieces).
  function joinNoSpaceWords(line){
    const tokens=String(line||'').trim().split(/\s+/).filter(Boolean);if(tokens.length<2)return String(line||'').trim();
    const sea=tokens.filter(t=>(t.match(SEA)||[]).length),wordSpaced=sea.length>=3&&sea.reduce((n,t)=>n+(t.match(SEA)||[]).length,0)/sea.length<=3.5;
    let out=tokens[0];
    for(let i=1;i<tokens.length;i++){const a=tokens[i-1].slice(-1),b=tokens[i][0],join=(CJK.test(a)&&CJK.test(b))||(wordSpaced&&NO_SPACE.test(a)&&NO_SPACE.test(b));out+=(join?'':' ')+tokens[i];}
    return out;
  }
  // The country and culture an AI Drama is set in: the chosen country, or the main country of the viewer language.
  function storyCulture(a){
    if(!isWorldDrama(a?.niche))return '';
    if(a.dramaCountry==='Custom')return String(a.customCountry||'').replace(/\s+/g,' ').trim().slice(0,120);
    if(a.dramaCountry&&a.dramaCountry!=='Auto (match the language)')return a.dramaCountry;
    if(a.language==='Custom')return 'the country where '+String(a.customLanguage||'the viewer language').replace(/\s+/g,' ').trim().slice(0,80)+' is mainly spoken';
    return LANGUAGE_COUNTRY[a.language]||'United States';
  }
  // AI narrator (owner 2026-10-31 narration plan): opt-in for off-screen narration only. The scene speech stays the
  // narration text; video prompts become visual-only (no spoken lines, lip movement or music). Never for visible
  // speakers, dialogue, drama or presenters.
  const NARRATION_OPTIONS=['Original video audio','AI narrator'],NARRATOR_NICHES=[59,60];
  const narrationEligible=a=>!isDrama(a?.niche)&&![35,41,42,55,56,57].includes(Number(a?.niche))&&(['B-roll with narration','Hands-only process'].includes(a?.format)||NARRATOR_NICHES.includes(Number(a?.niche)));
  const isFormatNiche=n=>((Number(n)>=41&&Number(n)<=55)||[59,60].includes(Number(n)))&&Number.isInteger(Number(n));
  // Long series (owner 2026-10-25, paid Pro only — the server checks the plan): 3 or 4 parts of 10-18 scenes each, for every
  // drama niche. The server plans the whole series first (an outline with one beat per scene) and writes each part in
  // pieces of at most 6 scenes (pieceSizes), so an 18-scene part is three normal-sized builds joined into one part.
  const LONG_SCENES=['10','12','14','16','18'],PIECE_MAX=6,STICK_FIGURES=['Clothed cartoon','Classic line'];
  const isLong=a=>a?.seriesLength==='long';
  // Video → Story (owner 2026-11-04): a Tagalog Drama rebuilt from the user's own video keeps the video's scene count,
  // 1-18 scenes per project, instead of the 6-8 the guided setup offers. Set only by video-reverse.js, never by the server.
  const REVERSE_SCENES=Array.from({length:18},(_,i)=>String(i+1)),reverseVideo=a=>a?.reverseVideo===true&&Number(a.niche)===34&&!isLong(a);
  function pieceSizes(count){const n=Number(count),k=Math.ceil(n/PIECE_MAX),base=Math.floor(n/k);return Array.from({length:k},(_,i)=>base+(i<n%k?1:0));}
  function steps(a = {}) {
    const n = Number(a.niche);
    const list = [
      {key:'niche', label:'Choose your niche', type:'niche'},
      {key:'topicMode', label:'How would you like to start?', options:['Suggest five ideas','Existing topic','Existing script','Creative brief','Reference description']},
      {key:'topic', label:a.topicMode === 'Existing script' ? 'Paste your exact script' : 'What is your video about?', type:'text'},
      {key:'language', label:'Viewer language', options:LANGUAGES}
    ];
    if(isWorldDrama(n))list.push({key:'dramaCountry',label:'Story country',options:DRAMA_COUNTRIES});
    if(isWorldDrama(n)&&a.dramaCountry==='Custom')list.push({key:'customCountry',label:'Which country or culture?',type:'text'});
    if(n===61)list.push({key:'animeStory',label:'Story world',options:ANIME_STORIES});
    // Stick Figure Explainer (owner 2026-10-31): the clothed cartoon (219e14d) or the classic white line figure, chosen per story.
    if(n===60)list.push({key:'stickFigure',label:'Stick figure',options:STICK_FIGURES});
    if(n===57)list.push({key:'kitchenMode',label:'Video type',options:['Food & body tips','Herbal tips',...(['Simple recipe','Preparation tip','Food explanation'].includes(a.kitchenMode)?[a.kitchenMode]:[])]},{key:'kitchenVoice',label:'Presenter voice',options:['Male','Female']});
    if (n===56)list.push({key:'ugcProductName',label:'Product name',type:'text'},{key:'ugcDescription',label:'What does your product do?',type:'text'},{key:'ugcTheme',label:'Ad theme',options:['Problem → solution','Product demonstration','Unboxing / first look','Everyday lifestyle','Offer / promotion']},{key:'ugcLocation',label:'Location',options:['Auto','Bedroom / vanity','Kitchen','Living room','Desk / workspace','Outdoor','Custom']});
    if(n===56&&a.ugcLocation==='Custom')list.push({key:'ugcCustomLocation',label:'Describe the location',type:'text'});
    if (a.language === 'Custom') list.push({key:'customLanguage', label:'Which language?', type:'text'});
    if ([16,17,18,19,20].includes(n)) list.push({key:'topicLane',label:'Choose the host’s topic lane',type:'text'});
    if ([27,29,31,32].includes(n)) list.push({key:'special', label:({27:'Describe your custom niche',29:'Which object will speak?',31:'Describe your recurring character',32:'Real speaker or AI speaker? Describe them.'})[n],type:'text'});
    if (n === 28) list.push({key:'lyrics',label:'Paste the song lyrics (music is exported as notes only)',type:'text'});
    if (n === 33) list.push({key:'sources',label:'Paste source URLs and relevant excerpts',type:'text'});
    // Story type comes before the scene count (owner 2026-11-05): a long series offers 10-18 scenes per part, and with the
    // old order Customize everything asked the scenes as a standalone story first, then set 12 per part without asking.
    if(isDrama(n))list.push({key:'partsTotal',label:isLong(a)?'Long series · 3 or 4 parts':'Story type · 1 = Standalone, 2 / 3 = Series',options:isLong(a)?['3','4']:['1','2','3']});
    // 15 s scenes (owner 2026-11-17): Flow Omni 1.2 Flash, Grok, Google Vids and Higgsfield make them.
    list.push({key:'sceneDuration',label:'Scene length · Veo: 8s · Gemini / Omni: 8s or 10s · 15s: Omni 1.2, Grok, Vids, Higgsfield · 20s / 30s: Higgsfield only',options:['8','10','15','20','30']},
      {key:'sceneCount',label:isDrama(n)&&isLong(a)?'How many scenes per part?':'How many scenes?',options:reverseVideo(a)?REVERSE_SCENES:isDrama(n)&&a.piece?['3','4','5','6','7','8']:isDrama(n)&&isLong(a)?LONG_SCENES:isFormatNiche(n)?['3','4','5','6','8','10']:n===35?['2','3']:n===39?['3','4','5','6']:isDrama(n)?['6','7','8']:['3','5','6','8','10']},
      {key:'format',label:'Visual format',options:n===57?['Character host and B-roll']:['Hands-only process','B-roll with narration','Character host and B-roll','Cinematic story']});
    if (![14,15,16,17,18,19,20,22,30,33].includes(n)) list.push({key:'style',label:'Visual style',options:n===39?['Claymation']:n===61?['Anime']:[59,60].includes(n)?['Flat illustration']:[36,37,40].includes(n)?['Stylized 3D']:n===38?['Anime','Stylized 3D']:['Photorealistic cinematic','Stylized 3D','Anime','Flat illustration','Documentary','Painterly','Cyberpunk','Custom']});
    if (a.style === 'Custom') list.push({key:'customStyle',label:'Describe the visual style',type:'text'});
    list.push({key:'imageMode',label:'How will you create the images?',options:['Extension image queue','Manual image upload','Prompts only']},
      {key:'exportProfile',label:'Video reference mode',options:n===57?['Scene image + video','Image prompts only']:['Scene image + video','Recurring assets + video','Image prompts only']},
      {key:'destination',label:'Keep your project',options:['Save in extension and export JSON','Save in extension']});
    return list;
  }
  // Prompts written in the user's own AI chat (owner 2026-11-09): no niche, no writing rules, the words stay as written.
  function importedSetup(a){
    const count=Number(a.sceneCount),flex=a.sceneLengths==='flex';
    if(!Number.isInteger(count)||count<1||count>60)throw Error('An imported project has 1 to 60 scenes.');
    if(!['Scene image + video','Recurring assets + video'].includes(a.exportProfile))throw Error('Invalid imported project type.');
    if(!['8','10'].includes(String(a.sceneDuration))||(flex&&String(a.sceneDuration)!=='10'))throw Error('Invalid imported scene length.');
    return {importedPackage:true,niche:'0',topicMode:'Reference description',topic:String(a.topic||'Imported story').slice(0,300),language:'As written',sceneDuration:String(a.sceneDuration),sceneCount:String(count),format:'Cinematic story',partsTotal:'1',partNumber:1,style:'As written',imageMode:'Extension image queue',exportProfile:a.exportProfile,destination:'Save in extension',imageWorkflow:a.exportProfile==='Recurring assets + video'?'Reference images first':'Direct scene frames',...(flex?{sceneLengths:'flex'}:{})};
  }
  function validateSetup(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw Error('Complete the guided setup first.');
    if(a.importedPackage===true)return importedSetup(a);
    if(a.seriesLength!==undefined&&a.seriesLength!==''&&a.seriesLength!==null&&(!isDrama(a.niche)||a.seriesLength!=='long'))throw Error('Long series are for drama stories only.');
    if(isDrama(a.niche))a={...a,partsTotal:String(a.partsTotal||1)};
    if(Number(a.niche)===61&&!a.animeStory)a={...a,animeStory:'Auto'};
    if(Number(a.niche)===60&&!a.stickFigure)a={...a,stickFigure:'Clothed cartoon'}; // drafts saved before the choice existed
    if (!Number.isInteger(Number(a.niche)) || Number(a.niche)<1 || Number(a.niche)>61) throw Error('Choose a valid niche.');
    for (const s of steps(a)) {
      const v = String(a[s.key] ?? '').trim();
      if (!v || v.length > 24000 || (s.options && !s.options.includes(v))) throw Error('Check: '+s.label);
    }
    const result=Object.fromEntries(steps(a).map(s => [s.key, String(a[s.key]).trim()]));
    // A pasted script is spoken word for word, so it must fit the voice budget of all scenes (owner 2026-10-30: a 2,585-word
    // script for 8 x 8 s failed four times and used up four stories).
    if(result.topicMode==='Existing script'&&!isLong(a)&&Number(a.partsTotal||1)===1){
      const words=spokenWords(spokenScript(result.topic)),scenes=Number(result.sceneCount),seconds=Number(result.sceneDuration),fit=Math.floor(scenes*seconds*2.5);
      if(scenes>0&&seconds>0&&words>fit)throw Error('Your script has about '+words+' words, but '+scenes+' scenes of '+seconds+' seconds fit only about '+fit+' spoken words. Shorten the script, or choose more or longer scenes.');
    }
    if(a.presetContext){if(typeof a.presetContext!=='string'||a.presetContext.length>2000)throw Error('Invalid template context.');result.presetContext=a.presetContext.trim();}
    if(a.narration!==undefined&&a.narration!==''&&a.narration!==null){if(!NARRATION_OPTIONS.includes(a.narration))throw Error('Check: Audio');if(a.narration==='AI narrator'){if(!narrationEligible(a))throw Error('AI narrator is for off-screen narration (B-roll or hands-only videos), not visible speakers.');result.narration='AI narrator';}}
    if(Number(a.niche)===56){
      if(a.topicMode!=='Creative brief'||a.exportProfile!=='Scene image + video'||a.imageWorkflow!=='Reference images first'||!['Hands-only process','B-roll with narration','Character host and B-roll'].includes(a.format))throw Error('UGC requires a product brief and Scene image + video with reference images first.');
      if(a.ugcVoice!==undefined){if(!['Male','Female'].includes(a.ugcVoice))throw Error('Choose Male or Female for the UGC voice.');result.ugcVoice=a.ugcVoice;}
      for(const key of ['ugcAudience','ugcOffer','ugcCTA','ugcPresenter']){if(a[key]!==undefined&&(typeof a[key]!=='string'||a[key].length>1500))throw Error('Invalid product brief.');if(a[key])result[key]=a[key].trim();}
      if(result.ugcProductName.length>120||result.ugcDescription.length>4000||(result.ugcCustomLocation||'').length>1500)throw Error('Product brief is too long.');
    }
    if(Number(a.niche)===57&&(!['Character host and B-roll'].includes(a.format)||a.imageWorkflow!=='Reference images first'||!['Scene image + video','Image prompts only'].includes(a.exportProfile)))throw Error('Kitchen videos use a presenter and reference images first with scene frames.');
    if(a.imageWorkflow){if(!['Direct scene frames','Reference images first'].includes(a.imageWorkflow))throw Error('Invalid image workflow.');result.imageWorkflow=a.imageWorkflow;}
    if(isLong(a))result.seriesLength='long';
    if(reverseVideo(a)){if(Number(a.partsTotal||1)!==1)throw Error('A video rebuild is saved as standalone projects.');result.reverseVideo=true;
      // Owner 2026-11-05: a rebuild follows the original's pace, so each scene is 4, 6, 8 or 10 s (sceneDuration stays the longest).
      // Owner 2026-11-07: with Omni 1.2 Flash any whole length from 3 to 15 s ('flex').
      if(['mixed','flex'].includes(a.sceneLengths)){if(String(a.sceneDuration)!=='10')throw Error('Mixed scene lengths use 10 seconds as the project length.');result.sceneLengths=a.sceneLengths;}}
    if(isDrama(a.niche)){
      const long=isLong(result),part=Number(a.partNumber||1),total=Number(result.partsTotal);
      if(!Number.isInteger(part)||part<1||part>total||total>(long?4:3))throw Error(long?'A long series has at most four ordered parts.':'Story supports at most three ordered parts.');result.partNumber=part;
      // "Continue the story" (owner 2026-11-11, Pro): a finished story goes on as a new season with the same cast.
      if(a.season!==undefined){const season=Number(a.season);if(!Number.isInteger(season)||season<2||season>50)throw Error('Invalid story season.');result.season=season;}
      // piece = one server-side slice of a long part (never sent by the extension): scenes from..to of the part's `of`.
      if(a.piece!==undefined){const x=a.piece;
        if(!long||!x||!Number.isInteger(x.index)||!Number.isInteger(x.total)||x.index<1||x.index>x.total||!Number.isInteger(x.from)||x.to-x.from+1!==Number(result.sceneCount)||!LONG_SCENES.includes(String(x.of))||x.to>x.of||!Array.isArray(x.beats)||x.beats.length!==Number(result.sceneCount)||x.beats.some(b=>typeof b!=='string'||b.length>800))throw Error('Invalid long-series piece.');
        if(x.plan!==undefined&&(typeof x.plan!=='string'||x.plan.length>20000))throw Error('Invalid long-series piece.');
        result.piece={index:x.index,total:x.total,from:x.from,to:x.to,of:x.of,beats:x.beats,...(x.plan?{plan:x.plan}:{})};
      }
      const seasonStart=result.season>1&&part===1&&!(result.piece?.index>1);
      if(part>1||result.piece?.index>1||seasonStart){const c=a.continuation;
        if(!c||c.previousPartNumber!==(result.piece?.index>1?part:seasonStart?0:part-1)||!['8','10','15','20','30'].includes(String(c.sceneDuration))||String(c.sceneDuration)!==result.sceneDuration||typeof c.summary!=='string'||!c.summary.trim()||c.summary.length>(long?60000:18000)||typeof c.voice!=='string'||!c.voice.trim()||c.voice.length>(long?8000:4000)||!Array.isArray(c.assets)||c.assets.length>(long?24:12))throw Error('Invalid previous-part continuity.');
        const ids=new Set();for(const x of c.assets){if(!/^asset_\d{3}$/.test(x.id)||ids.has(x.id)||typeof x.imagePrompt!=='string'||x.imagePrompt.length<40||x.imagePrompt.length>16000)throw Error('Invalid reusable asset.');ids.add(x.id);}
        result.continuation={previousPartNumber:c.previousPartNumber,sceneDuration:c.sceneDuration,summary:c.summary,voice:c.voice,assets:c.assets.map(x=>({id:x.id,imagePrompt:x.imagePrompt}))};
        if(c.castLooks!==undefined)result.continuation.castLooks=validateCastLooks(c.castLooks);
        if(long&&c.outline!==undefined)result.continuation.outline=validateOutline(c.outline,result.piece?{...result,sceneCount:String(result.piece.of)}:result);
        if(JSON.stringify(result.continuation).length>(long?200000:50000))throw Error('Previous-part context is too large.');
      }
    }
    return result;
  }
  // Each named person's fixed look (age, hair, build; no clothes), written with the story (owner 2026-10-25: two women got
  // the same default face). Direct-frame image prompts and storyboard sheets use it; later pieces and parts keep it.
  function validateCastLooks(list){
    if(!Array.isArray(list)||list.length>24)throw Error('Invalid character looks.');
    const names=new Set();
    return list.map(c=>{const name=typeof c?.name==='string'?c.name.trim():'',look=typeof c?.look==='string'?c.look.trim():'';
      if(!name||name.length>80||!look||look.length>400||names.has(name.toLowerCase()))throw Error('Invalid character looks.');names.add(name.toLowerCase());return {name,look};});
  }
  // The long-series plan written before Part 1: one line per scene for every part, so a short premise or a suggested idea
  // grows into the full length the user chose (owner 2026-10-25), and later parts and pieces follow the same arc.
  function outlineSchema(setup){
    const parts=Number(setup.partsTotal),scenes=Number(setup.sceneCount);
    return {type:'object',additionalProperties:false,required:['title','logline','parts'],properties:{title:text,logline:text,parts:{type:'array',minItems:parts,maxItems:parts,items:{type:'object',additionalProperties:false,required:['part','title','summary','beats'],properties:{part:{type:'number'},title:text,summary:text,beats:{type:'array',minItems:scenes,maxItems:scenes,items:text}}}}}};
  }
  function validateOutline(o,setup){
    const parts=Number(setup.partsTotal),scenes=Number(setup.sceneCount),str=(s,max)=>typeof s==='string'&&s.trim()&&s.length<=max;
    if(!o||typeof o!=='object'||!str(o.title,200)||!str(o.logline,1200)||!Array.isArray(o.parts)||o.parts.length!==parts)throw Error('The series plan does not match the chosen parts.');
    const clean={title:o.title.trim(),logline:o.logline.trim(),parts:o.parts.map((p,i)=>{
      if(!p||!str(p.title,200)||!str(p.summary,2000)||!Array.isArray(p.beats)||p.beats.length!==scenes||p.beats.some(b=>!str(b,800)))throw Error('Part '+(i+1)+' of the series plan does not have '+scenes+' scene beats.');
      return {part:i+1,title:p.title.trim(),summary:p.summary.trim(),beats:p.beats.map(b=>b.trim())};
    })};
    if(JSON.stringify(clean).length>60000)throw Error('The series plan is too long.');
    return clean;
  }
  function validateDramaScene(scene,flexible=false){
    const time=s=>{const [m,v]=s.split(':');return Number(m)*60+Number(v);};
    const shots=[...scene.videoPrompt.matchAll(/\[(\d{1,2}:\d{2}(?:\.\d+)?)\s*[-–]\s*(\d{1,2}:\d{2}(?:\.\d+)?)\]\s*SHOT\s*\d+\s*[—-]([^]*?)(?=\[\d{1,2}:|\nAUDIO\s*[—-]|$)/g)];
    if(!shots.length)throw Error('Tagalog drama needs a timed shot timeline.');let end=0;
    for(const shot of shots){if(Math.abs(time(shot[1])-end)>.01||time(shot[2])<=end)throw Error('Tagalog shot timeline has gaps or overlaps.');end=time(shot[2]);}
    if(end!==scene.durationSeconds)throw Error('Tagalog shot timeline duration differs from scene.');
    if(flexible||scene.speech.trim()){
      if(!flexible&&(shots.length<3||!/SILENT HOOK|No dialogue/i.test(shots[0][3])||!/BREATHER|no dialogue/i.test(shots.at(-1)[3])))throw Error('Tagalog dialogue requires a silent opening and breather.');
      // Niche 34 can speak in any shot. Validate every quoted turn, including
      // opening/closing shots and silent scenes, rather than assuming bookends.
      const dialogueShots=flexible?shots:shots.slice(1,-1);
      const lines=dialogueShots.map(s=>[...s[3].matchAll(/["“]([^"”]+)["”]/g)].map(x=>x[1]).join(' '));
      if(lines.join(' ').replace(/\s+/g,' ').trim()!==scene.speech.replace(/\s+/g,' ').trim())throw Error('Tagalog timeline speech does not match spoken words.');
      dialogueShots.forEach((s,i)=>{const duration=time(s[2])-time(s[1]),max=({2:6,2.5:8,3:10,3.5:12,4:13,4.5:15,5:16})[duration]||Math.floor(duration*3.3);if(spokenWords(lines[i])>max)throw Error('Tagalog dialogue exceeds its individual shot word budget.');});
    }
  }
  function validatePaldoScene(scene){
    const time=s=>{const [m,v]=s.split(':');return Number(m)*60+Number(v)};
    const shots=[...scene.videoPrompt.matchAll(/^(?:-\s*)?\[(\d{1,2}:\d{2}(?:\.\d+)?)\s*[-–]\s*(\d{1,2}:\d{2}(?:\.\d+)?)\]([^]*?)(?=\n(?:-\s*)?\[\d{1,2}:|\nAUDIO|$)/gm)];
    // Same checks as before; each failure names the scene and exactly what is missing or wrong (shown in diagnostics / the dashboard).
    const id=scene.id||'a scene',missing=[];
    if(!/OPENING STATE/i.test(scene.videoPrompt))missing.push('the "OPENING STATE:" line');
    if(!/CHARACTERS\s*[—–-]/.test(scene.videoPrompt))missing.push('the "CHARACTERS —" block (with the long dash)');
    if(!/Screen side:/i.test(scene.videoPrompt))missing.push('"Screen side: camera LEFT/RIGHT" on the character lines');
    if(!shots.length)missing.push('timed shot lines starting with [00:00-00:04]');
    if(missing.length)throw Error('Paldo '+id+' is missing '+(missing.length>1?missing.slice(0,-1).join(', ')+' and '+missing.at(-1):missing[0])+'.');
    let end=0,lines=[];for(const shot of shots){const duration=time(shot[2])-time(shot[1]),label='['+shot[1]+'-'+shot[2]+']';
      if(duration<=0)throw Error('Paldo '+id+' shot '+label+' has no length.');
      if(Math.abs(time(shot[1])-end)>.01)throw Error('Paldo '+id+' shot '+label+' should start at '+end+'s ('+(time(shot[1])>end?'gap':'overlap')+' in the timeline).');
      end=time(shot[2]);const spoken=[...shot[3].matchAll(/["“]([^"”]+)["”]/g)].map(m=>m[1]).join(' '),words=spokenWords(spoken),limit=Math.ceil(duration*3);
      if(words>limit)throw Error('Paldo '+id+' shot '+label+' has '+words+' spoken words in '+duration+'s (limit '+limit+').');if(spoken)lines.push(spoken);}
    if(end!==scene.durationSeconds)throw Error('Paldo '+id+' timeline ends at '+end+'s but the scene is '+scene.durationSeconds+'s.');
    if(lines.join(' ').replace(/\s+/g,' ').trim()!==scene.speech.replace(/\s+/g,' ').trim())throw Error('Paldo '+id+': the quoted lines in the timeline do not match the scene speech word for word.');
    if([scene.imagePrompt,scene.videoPrompt].some(t=>t.includes('@')))throw Error('Paldo '+id+' prompt contains "@" (not allowed).');
  }
  const sceneHeadings={34:'TAGALOG DRAMA',58:'AI DRAMA',61:'ANIME DRAMA',36:'FRUIT MICRO-DRAMA',37:'PET SOAP OPERA',38:'PINOY FOLKLORE HORROR',39:'FILIPINO CLAYMATION COMEDY',40:'KWENTONG MAY ARAL',41:'TINY WORKERS',42:'IMPOSSIBLE ASMR',43:'TIME TRAVEL POV',44:'CREATURE VLOG COMEDY',45:'KAPRE VLOGS',46:'POV HISTORY',47:'PERA MATTERS',48:'LUXURY FILES',49:'UNSOLVED PH',50:'HALLOWEEN SPECIALS',51:'SARI-SARI CONFESSIONS',52:'BLOTTER NGAYON GABI',53:'JEEPNEY DIARIES',54:'REVERSE HISTORY',55:'PODCAST HUGOT HOST',59:'ANIMATED SHORT FILM',60:'STICK FIGURE EXPLAINER'};
  function sceneHeading(setup,seconds=setup.sceneDuration){const heading=sceneHeadings[Number(setup.niche)];return heading?heading+' — '+seconds+'-SECOND SCENE':null;}
  const MIXED_LENGTHS=[4,6,8,10],FLEX_MIN=3,FLEX_MAX=15;
  const ownLengths=setup=>['mixed','flex'].includes(setup?.sceneLengths);
  // The length of one scene: its own with mixed/flex scene lengths, otherwise the project's.
  const sceneSeconds=(s,setup)=>ownLengths(setup)?Number(s.durationSeconds):Number(setup.sceneDuration);
  function validateSceneHeading(scene, setup) {
    const heading=sceneHeadings[Number(setup.niche)];if(!heading)return;
    const expected=sceneHeading(setup,sceneSeconds(scene,setup));
    const actual=String(scene.videoPrompt).trim().split(/\r?\n/)[0].trim();
    if(actual!==expected){
      const found=JSON.stringify(actual.slice(0,160)+(actual.length>160?'…':'')).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
      throw Error('Incorrect niche heading in '+scene.id+': expected '+expected+'; found '+found+'.');
    }
  }
  // Upgrade only the known copied Fruit label in saved 39/40 projects; assets and scene content stay intact.
  function normalizeLegacySceneHeadings(p, setup) {
    const heading=sceneHeadings[Number(setup.niche)];if(![39,40].includes(Number(setup.niche))||!Array.isArray(p?.scenes))return p;
    let changed=false;const scenes=p.scenes.map(s=>{const old='FRUIT MICRO-DRAMA — '+setup.sceneDuration+'-SECOND SCENE';
      if(s.videoPrompt?.split(/\r?\n/)[0]!==old)return s;changed=true;
      return {...s,videoPrompt:heading+s.videoPrompt.slice('FRUIT MICRO-DRAMA'.length)};
    });return changed?{...p,scenes}:p;
  }
  // User report 2026-11-18 ("Tagalog drama prompts must not contain @ mentions" on Part 2): a Flow run copied its queue
  // text, which carries Flow's @picture tags, back into a repaired scene. Each tag is "@" + the picture name
  // (p01_asset_002_ab12cd34): it becomes "Image n" again (n = its place in the scene's references, the scene's own frame
  // is Image 1), and any other "@" right before a word is dropped.
  function healFlowTags(p){
    if(!Array.isArray(p?.scenes))return p;let changed=false;
    const scenes=p.scenes.map(s=>{const t=typeof s?.videoPrompt==='string'?s.videoPrompt:'';if(!t.includes('@'))return s;
      const refs=Array.isArray(s.references)?s.references:[];
      const out=t.replace(/@p\d{2,}_((?:asset|scene)_\d{3})(?:_[a-f0-9]{8})?(?![\p{L}\p{N}_])/gu,(all,id)=>{const n=id===s.id?0:refs.indexOf(id);return n>=0?'Image '+(n+1):id;})
        .replace(/@(?=[\p{L}\p{N}_-])/gu,'');
      if(out===t)return s;changed=true;return {...s,videoPrompt:out};});
    return changed?{...p,scenes}:p;
  }
  function validateProject(p, setup) {
    // Our local server returns placeholder projects (no AI key yet). Accept them without the strict
    // server-shape checks so the end-to-end flow works; real generated projects still validate fully.
    if (p && p.__localStub) return {...p, schemaVersion: VERSION, state: 'prompts_ready', imagesReviewed: false,
      durationSeconds: Array.isArray(p.scenes) ? p.scenes.reduce((t, s) => t + (Number(s.durationSeconds) || 0), 0) : 0};
    // flexibleScenes:false = the server's temporary 1.13.38 compatibility check (dramaCompatScenes), kept through validateSetup.
    // legacyShapes = the server checks with the store 1.13.40/41 rules (owner 2026-10-28 "requires a silent opening and breather"):
    // there only niche 34 and 55 may speak in the first/last shot, so every other dialogue scene keeps short silent bookends.
    const a = Object.assign(validateSetup(setup), setup?.flexibleScenes === false ? {flexibleScenes: false} : {}, setup?.legacyShapes ? {legacyShapes: true} : {}), count = Number(a.sceneCount);
    if (!p || typeof p.title !== 'string' || !p.title.trim() || p.title.length > 200) throw Error('Missing project title.');
    // An 18-scene part of a long series can need more character/location cards than a 6-8 scene story.
    if (!Array.isArray(p.assets) || p.assets.length > (a.importedPackage?40:isLong(a)||a.reverseVideo?20:12) || !Array.isArray(p.scenes) || p.scenes.length !== count) throw Error('Incorrect asset or scene count.');
    if (p.seriesOutline!==undefined) { if (!isLong(a)) throw Error('Only a long series has a series plan.'); p={...p,seriesOutline:validateOutline(p.seriesOutline,a)}; }
    if (p.castLooks!==undefined) p={...p,castLooks:validateCastLooks(p.castLooks)};
    const ids = new Set();
    const check = (x, prefix) => {
      if (!x || !new RegExp('^'+prefix+'_[0-9]{3}$').test(x.id) || ids.has(x.id)) throw Error('Invalid or duplicate reference ID.');
      ids.add(x.id);
      if (typeof x.imagePrompt !== 'string' || x.imagePrompt.length < 40 || x.imagePrompt.length > 16000) throw Error('Incomplete image prompt.');
    };
    p.assets.forEach(x => check(x, 'asset'));
    if(isDrama(a.niche)&&p.assets.some(x=>x.imagePrompt.includes('@')))throw Error('Tagalog asset prompts must not contain @ mentions.');
    p.scenes.forEach((s,i) => {
      check(s,'scene');
      if (s.id !== 'scene_'+String(i+1).padStart(3,'0')) throw Error('Scene timing IDs must be consecutive.');
      if (a.sceneLengths==='flex' ? !(Number.isInteger(s.durationSeconds)&&s.durationSeconds>=FLEX_MIN&&s.durationSeconds<=FLEX_MAX) : a.sceneLengths==='mixed' ? !MIXED_LENGTHS.includes(s.durationSeconds) : s.durationSeconds !== Number(a.sceneDuration)) throw Error(a.sceneLengths==='flex' ? 'Scene length must be a whole number of seconds from 3 to 15: received '+s.durationSeconds+' in '+s.id+'.' : a.sceneLengths==='mixed' ? 'Scene length must be 4, 6, 8 or 10 seconds: received '+s.durationSeconds+' in '+s.id+'.' : 'Scene timing must match your selected duration: expected '+a.sceneDuration+' seconds, received '+s.durationSeconds+'.');
      if (!Array.isArray(s.references) || s.references.some(id => !p.assets.some(x=>x.id===id)) || new Set(s.references).size !== s.references.length) throw Error('Unknown or duplicate asset reference.');
      if (typeof s.speech !== 'string' || spokenWords(s.speech) > sceneSeconds(s,a)*(a.narration==='AI narrator'?3.2:2.5)) throw Error('Speech exceeds the scene voice budget.');
      if (typeof s.videoPrompt !== 'string' || s.videoPrompt.length < 40 || s.videoPrompt.length > 16000) throw Error('Incomplete video prompt.');
      if (typeof s.caption !== 'string') throw Error('Missing caption notes.');
      validateSceneHeading(s,a);
      if(a.narration==='AI narrator'&&/["“][^"”]{12,}["”]/.test(s.videoPrompt))throw Error('AI narrator: '+s.id+' video prompt still contains a spoken line. Video prompts must be visual-only; the words stay in speech.');
      if(isFormatNiche(a.niche)){
        if(a.exportProfile==='Recurring assets + video'&&!s.references.length)throw Error('Ingredients scenes require at least one asset reference.');
        if([s.imagePrompt,s.videoPrompt].some(t=>t.includes('@')))throw Error('Creative format prompts must not contain @ mentions.');
        if(!/OPENING STATE/i.test(s.imagePrompt)||!/OPENING STATE/i.test(s.videoPrompt)||!/TIMELINE/i.test(s.videoPrompt))throw Error('Creative formats require opening state and timeline.');
        // 55 Podcast Hugot Host (owner 2026-10-23), the 59/60 narrated cartoon and stick-figure films (owner 2026-10-31) and the 50/51/52/53 two-turn dialogue layout (owner 2026-10-28) may speak in any shot: no forced silent hook/breather; per-shot word ceilings stay.
        // AI narrator: the timeline stays, the spoken lines move to the separate narration track (checked below).
        if(a.narration==='AI narrator')validateDramaScene({...s,speech:''});
        else validateDramaScene(s,a.legacyShapes?[55,59,60].includes(Number(a.niche)):[50,51,52,53,55,59,60].includes(Number(a.niche)));
      }
      if(Number(a.niche)===35)validatePaldoScene(s);
      if(isDrama(a.niche)){
        if([s.imagePrompt,s.videoPrompt,s.speech,s.caption].some(t=>t.includes('@')))throw Error('Tagalog drama prompts must not contain @ mentions.');
        if(!/OPENING STATE/i.test(s.imagePrompt)||!/OPENING STATE/i.test(s.videoPrompt)||!/TIMELINE/i.test(s.videoPrompt))throw Error('Tagalog drama requires opening state and timeline.');
        if(s.references.length>10)throw Error('Tagalog drama supports at most ten visible references.');
        validateDramaScene(s,a.flexibleScenes!==false&&(!a.legacyShapes||[34,58,61].includes(Number(a.niche)))); // adaptive shots for every drama niche (owner 2026-10-28)
      }
    });
    if (a.topicMode === 'Existing script' && !sameScript(p.scenes.map(s=>s.speech),a.topic)) throw Error('The supplied script was changed or omitted.');
    if (typeof p.voice !== 'string' || !p.voice.trim()) throw Error('Missing voice lock.');
    if(a.continuation){
      if(!p.voice.startsWith(a.continuation.voice))throw Error('Previous character voice locks changed.');
      const max=Math.max(0,...a.continuation.assets.map(x=>Number(x.id.slice(6))));
      for(const asset of p.assets){const old=a.continuation.assets.find(x=>x.id===asset.id);if(old&&old.imagePrompt!==asset.imagePrompt)throw Error('An existing character or asset was redesigned.');if(!old&&Number(asset.id.slice(6))<=max)throw Error('New assets must use fresh IDs.');}
    }
    if(Number(a.niche)===56&&(!p.assets.some(x=>x.id==='asset_001')||p.scenes.some(s=>!s.references.includes('asset_001'))))throw Error('UGC scenes must reference the uploaded product as asset_001.');
    const direct=a.imageWorkflow==='Direct scene frames'&&a.exportProfile!=='Recurring assets + video';
    const used=new Set(p.scenes.flatMap(s=>s.references));
    if(isDrama(a.niche))p=checkCharacterNames(p);
    if([36,37].includes(Number(a.niche))&&[...p.assets,...p.scenes].some(x=>/photorealistic|live.action/i.test(x.imagePrompt+' '+(x.videoPrompt||''))))throw Error('Animated food/pet prompts must use stylized3D, not live action.');
    return {...p,assets:direct?[]:p.assets.filter(x=>used.has(x.id)),scenes:direct?p.scenes.map(s=>({...s,references:[]})):p.scenes, schemaVersion:VERSION, setup:a, durationSeconds:p.scenes.reduce((t,s)=>t+sceneSeconds(s,a),0), state:'prompts_ready', imagesReviewed:false};
  }
  const text = {type:'string'};
  const object = properties => ({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const schema = object({title:text,voice:text,assets:{type:'array',items:object({id:text,imagePrompt:text})},scenes:{type:'array',items:object({id:text,durationSeconds:{type:'number'},speech:text,caption:text,imagePrompt:text,videoPrompt:text,references:{type:'array',items:text}})}});
  const topicSchema=object({topics:{type:'array',minItems:5,maxItems:5,items:text}});
  // Hook Lab (owner 2026-10-29/30): three alternative openings for Scene 1, each a visible action plus the first spoken line.
  const hookSchema=object({hooks:{type:'array',minItems:3,maxItems:3,items:object({action:text,line:text})}});
  function validateHooks(p){const clean=v=>typeof v==='string'?v.replace(/\s+/g,' ').trim().replace(/^["“”']+|["“”']+$/g,''):'';const hooks=Array.isArray(p?.hooks)?p.hooks.map(h=>({action:clean(h?.action),line:clean(h?.line)})):[];if(hooks.length!==3||hooks.some(h=>h.line.length<5||h.line.length>200||h.action.length<5||h.action.length>240)||new Set(hooks.map(h=>h.line.toLowerCase())).size!==3)throw Error('Expected three distinct opening hooks.');return hooks;}
  function checkCharacterNames(p){
    const normalize=n=>n.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    const clean=n=>{
      n=n.trim().replace(/^(?:[-*•]\s+)/,'').replace(/\s+/g,' ');
      for(let i=0;i<3;i++){
        const wrapped=n.match(/^(?:\*\*(.+)\*\*|__(.+)__|"(.+)"|“(.+)”|'(.+)'|‘(.+)’)$/);
        if(!wrapped)break;n=wrapped.slice(1).find(x=>x!==undefined).trim();
      }
      return n;
    };
    // A sheet/card declares the same identity as the legacy reference-image wording.
    // Normalize once so voice/asset spelling variants do not create duplicate fuzzy matches.
    const names=new Map(),add=raw=>{const name=clean(raw),key=normalize(name);if(name&&!names.has(key))names.set(key,name);};
    for(const m of p.voice.matchAll(/(?:^|[;\n])\s*([^;\n—–:]+?)\s*[—–:]/g))add(m[1]);
    for(const asset of p.assets){const m=asset.imagePrompt.match(/\bcharacter reference (?:image|sheet|card) of ([^,.;\n]+)[,.;\n]/i);if(m)add(m[1]);}
    // Every named person also has a fixed look (castLooks): a side character who never speaks ("Mang Tino") is no longer
    // an unknown name (owner's 16-scene test 2026-10-25 failed on it).
    for(const c of Array.isArray(p.castLooks)?p.castLooks:[])if(typeof c?.name==='string')add(c.name);
    const distance=(a,b)=>{const row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){let prev=row[0];row[0]=i;for(let j=1;j<=b.length;j++){const old=row[j];row[j]=Math.min(row[j]+1,row[j-1]+1,prev+(a[i-1]===b[j-1]?0:1));prev=old;}}return row[b.length];};
    return {...p,scenes:p.scenes.map(scene=>({...scene,videoPrompt:scene.videoPrompt.replace(/(CHARACTERS\s*[—–-])([^]*?)(?=\nTIMELINE)/g,(all,heading,block)=>heading+block.replace(/^([^\n]+?)\s+[—–-](?=.+?Screen side:)/gmi,(line,raw)=>{
      const name=clean(raw),key=normalize(name),exact=names.get(key);
      const near=exact?[exact]:[...names].filter(([known])=>key.length>=3&&distance(known,key)===1).map(([,canonical])=>canonical);
      if(near.length!==1)throw Error('Unknown or ambiguous CHARACTERS name "'+name+'" in '+scene.id+'. Match the voice lock or asset name.');
      return line.replace(raw,near[0]);
    }))}))};
  }
  function validateTopics(p){if(!p||!Array.isArray(p.topics)||p.topics.length!==5||p.topics.some(t=>typeof t!=='string'||t.trim().length<5||t.length>500)||new Set(p.topics).size!==5)throw Error('Expected five distinct topic ideas.');return p.topics;}
  // Every story names its pictures p01_scene_001.jpg / p01_asset_001.jpg, so a Flow project used for several stories holds
  // many same-named pictures (user report 2026-11-04: wrong or missing frame in a busy project). Flow gets the name plus the
  // first 8 characters of the picture's sha256: the same picture keeps its name, a different picture never shares it.
  // Files saved to disk keep the plain name.
  function flowName(m){const tag=String(m?.sha256||'').slice(0,8);return /^[a-f0-9]{8}$/.test(tag)?String(m.name).replace(/(\.[a-z0-9]+)?$/i,'_'+tag+'$1'):m?.name;}
  function videoPlan(project,media,reviewed,platform,model=''){
    const p=validateProject(healFlowTags(project),project.setup);
    if(!reviewed)throw Error('Review and approve the images first.');
    if(p.setup.exportProfile==='Image prompts only'||p.setup.imageMode==='Prompts only')throw Error('This is an image/prompt-only project.');
    const duration=Number(p.setup.sceneDuration),omni=platform==='flow'&&/^omni1[12]flash$/.test(String(model).toLowerCase().replace(/[^a-z0-9]/g,''));// Omni 1.1 or 1.2 Flash (1.2 added 2026-11-06)
    // Google Vids (owner 2026-11-14, videos only): one 3-15 s length for the whole run, so every scene must share it.
    const vids=platform==='vids';
    // Higgsfield (owner 2026-11-17, videos only): each video has its own length; the engine reads the model's Duration
    // slider and uses the scene's length, or the nearest one the model allows.
    const higgs=platform==='higgsfield',omni12=platform==='flow'&&currentFlowModel(model)==='Omni 1.2 Flash';
    if(vids&&!(Number.isInteger(duration)&&duration>=3&&duration<=15))throw Error('Google Vids makes 3–15 second videos. Choose Flow, Gemini, Grok or Higgsfield for this story.');
    if(higgs&&!(Number.isInteger(duration)&&duration>=1&&duration<=30))throw Error('Higgsfield makes videos up to 30 seconds. This story uses '+duration+'s scenes.');
    // 15 s scenes (owner 2026-11-17): Flow Omni 1.2 Flash, Grok, Google Vids or Higgsfield.
    if(!vids&&!higgs&&(!['flow','gemini','grok'].includes(platform)||(duration!==8&&!(duration===10&&(omni||platform==='gemini'||platform==='grok'))&&!(duration===15&&(omni12||platform==='grok')))))
      throw Error(duration>15?'Scenes longer than 15 seconds need Higgsfield. This story uses '+duration+'s scenes.':duration===15&&['flow','gemini','grok'].includes(platform)?'15-second scenes need Flow with Omni 1.2 Flash, Grok, Google Vids or Higgsfield.':'Use 8-second scenes, or Gemini / Flow Omni 1.2 Flash for 10-second scenes.');
    if(ownLengths(p.setup)&&!omni&&!higgs&&p.scenes.some(s=>s.durationSeconds!==duration))throw Error('This video rebuild has scenes of different lengths ('+(p.setup.sceneLengths==='flex'?'3–15':'4–10')+' s). Make its videos in Flow with Omni 1.2 Flash, or on Higgsfield.');
    // 3-15 s scenes (owner 2026-11-07) need Omni 1.2 Flash; with Omni 1.1 Flash each rounds up to 4/6/8/10 (at most 10).
    const roundUp=!vids&&!higgs&&p.setup.sceneLengths==='flex'&&currentFlowModel(model)!=='Omni 1.2 Flash',planSeconds=s=>{const n=sceneSeconds(s,p.setup);return roundUp?MIXED_LENGTHS.find(l=>l>=n)||10:n;};
    const valid=id=>media[id]?.blob?.size>0&&/^[a-f0-9]{64}$/.test(media[id].sha256||'');
    const assetMode=p.setup.exportProfile==='Recurring assets + video';
    if(assetMode&&(!p.assets.length||p.scenes.some(s=>!s.references.length)))throw Error('Asset-reference mode requires an assigned asset in every scene.');
    if(platform==='grok'&&assetMode&&p.scenes.some(s=>s.references.length<2))throw Error('Grok needs at least two references per scene. Use Scene image + video, or choose Flow / Gemini.');
    if((assetMode?p.assets:[...p.assets,...p.scenes]).some(x=>!valid(x.id)))throw Error('Missing approved image data or fingerprint.');
    const ids=(assetMode?p.assets:p.scenes).map(x=>x.id);
    return {mode:assetMode?'ingredients-to-video':'frame-to-video',ids,entries:p.scenes.map(s=>({durationSeconds:planSeconds(s),text:s.videoPrompt,imageName:assetMode?'':flowName(media[s.id]),referenceNames:(assetMode?s.references:[s.id]).map(id=>flowName(media[id])),sceneId:s.id}))};
  }
  // Flow retires Omni 1.1 Flash, Veo 3.1 - Fast and Veo 3.1 - Quality on 2026-12-05 (owner 2026-11-07; Veo 3.1 - Lite stays).
  // Until then they stay, labelled "leaving Dec 5" (switching early would double users' credits without warning). From that
  // day saved stories, templates and settings that name them use Omni 1.2 Flash. Empty (Flow's current model) stays empty.
  const FLOW_VIDEO_MODEL='Omni 1.2 Flash',FLOW_RETIRE_AT=Date.UTC(2026,11,5),FLOW_VIDEO_MODELS=['Omni 1.1 Flash','Omni 1.2 Flash','Veo 3.1 - Lite','Veo 3.1 - Lite [Lower Priority]','Veo 3.1 - Fast','Veo 3.1 - Quality'];
  function flowModelLeaving(m){return /^(omni\s*1\.1\b|omni\s*flash$|veo\s*3\.1\s*-?\s*(fast|quality)\b)/i.test(String(m??'').trim());}
  function currentFlowModel(m,now=Date.now()){const s=String(m??'').trim();return now>=FLOW_RETIRE_AT&&flowModelLeaving(s)?FLOW_VIDEO_MODEL:s;}
  function flowVideoModels(now=Date.now()){return FLOW_VIDEO_MODELS.filter(m=>currentFlowModel(m,now)===m);}
  function flowModelLabel(m,now=Date.now()){return flowModelLeaving(m)&&now<FLOW_RETIRE_AT?m+' · leaving Dec 5':m;}
  function generationTargets(target={},fallback={}){
    target=target||{};const image=target.imagePlatform||target.platform||fallback.platform||'flow',video=target.videoPlatform||target.platform||fallback.platform||'flow';
    return {imagePlatform:['flow','gemini','chatgpt','grok'].includes(image)?image:'flow',videoPlatform:['flow','gemini','grok'].includes(video)||(['vids','higgsfield'].includes(video)&&target.videoPlatform===video)?video:'flow',model:currentFlowModel(target.model??fallback.flowModel??'Omni 1.1 Flash')};
  }
  function nextPartSetup(current,parts,options={}){
    const imageFinished=current.setup.exportProfile==='Image prompts only'&&current.state==='images_reviewed';
    const externalFinished=options.videosFinishedElsewhere===true&&current.setup.exportProfile!=='Image prompts only'&&['images_reviewed','video_ready'].includes(current.state);
    const factoryIncomplete=options.factory===true&&options.allowIncompleteMedia===true&&!current.libraryCastReview&&['images_reviewed','video_ready'].includes(current.state);
    if(!isDrama(current.setup.niche)||(current.state!=='videos_finished'&&!imageFinished&&!externalFinished&&!factoryIncomplete)||!current.imagesReviewed)throw Error('Finish and approve the current Tagalog Drama part first.');
    const long=isLong(current.setup),number=Number(current.setup.partNumber||1)+1;if(number>Number(current.setup.partsTotal||1))throw Error('This standalone story or series is complete; continuation is not available.');if(number>(long?4:3))throw Error(long?'This series has reached its four-part limit.':'This story has reached its three-part limit.');
    const assets=[...new Map(parts.flatMap(p=>p.project.assets).map(x=>[x.id,x])).values()];
    if(assets.some(x=>!current.media[x.id]?.blob?.size||!/^[a-f0-9]{64}$/.test(current.media[x.id]?.sha256||'')))throw Error('Approved reusable asset images are missing.');
    // Anime Drama v2: each scene's STORY line names the magic it shows (its rule and cost), so later parts keep the same rules.
    const storyLines=p=>Number(p.setup.niche)===61?'\nSTORY LINES (what each scene was about, with the magic rules and costs already established — keep them):\n'+p.project.scenes.map(s=>s.id+': '+((String(s.videoPrompt).match(/(?:^|\n)STORY\s*[—-]\s*([^\n]+)/)||[])[1]||'').slice(0,400)).join('\n'):'';
    let summary=parts.map(p=>'PART '+(p.setup.partNumber||1)+' — '+p.project.title+'\n'+p.project.scenes.map(s=>s.id+': '+s.speech).join('\n')+storyLines(p)+'\nFINAL VISIBLE STATE / ENDING:\n'+p.project.scenes.at(-1).videoPrompt.split(/\nAUDIO\s*[—-]/)[0].slice(-3500)).join('\n\n');
    // A long series carries its plan (made with Part 1) to every later part, so Part 3 still follows the same arc.
    const outline=long?parts.map(p=>p.project.seriesOutline).find(Boolean)||current.project.seriesOutline:undefined;
    // Everyone's fixed look from every part so far (first written wins), so Part 2 draws the same people.
    const looksByName=new Map();for(const c of [...parts.flatMap(p=>p.project.castLooks||[]),...(current.project.castLooks||[])])if(!looksByName.has(c.name.toLowerCase()))looksByName.set(c.name.toLowerCase(),c);
    // A part inside a later season also carries the recap of the earlier seasons (kept short so the part still fits).
    const seasonStart=parts.find(x=>Number(x.setup.partNumber||1)===1)?.setup,limit=long?60000:18000;
    if(Number(seasonStart?.season)>1&&seasonStart.continuation?.summary){const room=limit-summary.length-200;if(room>500)summary='EARLIER STORY (before this season, recap):\n'+String(seasonStart.continuation.summary).slice(-Math.min(8000,room))+'\n\n'+summary;}
    return validateSetup({...current.setup,topicMode:'Existing topic',topic:'Continue the established story from the supplied final visible state. Develop the next part without repeating earlier events.'+(String(options.notes||'').trim()?' CREATOR NOTES FOR THIS PART (how viewers reacted to the last part; follow them while keeping the same characters, looks and continuity): '+String(options.notes).replace(/\s+/g,' ').trim().slice(0,600):''),partNumber:number,partsTotal:String(current.setup.partsTotal),continuation:{previousPartNumber:number-1,sceneDuration:current.setup.sceneDuration,summary,voice:current.project.voice,assets,...(outline?{outline}:{}),...(looksByName.size?{castLooks:[...looksByName.values()].slice(0,24)}:{})}});
  }
  // "Continue the story" (owner 2026-11-11, Pro only): when the last part of a drama is finished, the story goes on as a new
  // season: Part 1 of a new series with the same characters, outfits and places (approved images reused) and a fresh main
  // conflict that starts after the ending. Earlier seasons travel as a short recap, so a story can keep going season after
  // season without the context growing. The member picks how many parts the new season has (same story type and scenes).
  function storyFinished(p){return p.state==='videos_finished'||(p.setup?.exportProfile==='Image prompts only'&&p.state==='images_reviewed'&&p.imagesReviewed);}
  function seasonAction(setup){if(!isDrama(setup?.niche)||Number(setup.partNumber||1)<Number(setup.partsTotal||1))return null;return {label:'Continue the story →',season:Number(setup.season||1)+1};}
  function nextSeasonSetup(current,parts,options={}){
    if(!isDrama(current.setup.niche)||!storyFinished(current)||!current.imagesReviewed)throw Error('Finish and approve the last part of this story first.');
    if(Number(current.setup.partNumber||1)<Number(current.setup.partsTotal||1))throw Error('Finish every part of this story first, then continue it.');
    const long=isLong(current.setup),season=Number(current.setup.season||1)+1,total=String(options.partsTotal||(long?'3':'1'));
    if(!(long?['3','4']:['1','2','3']).includes(total))throw Error(long?'A long series season has 3 or 4 parts.':'Choose 1, 2 or 3 parts for the next season.');
    if(season>50)throw Error('This story has reached 50 seasons.');
    const done=parts.filter(x=>x.project?.scenes?.length).sort((a,b)=>Number(a.setup.partNumber||1)-Number(b.setup.partNumber||1));
    if(!done.length||done.at(-1).id!==current.id)throw Error('Continue from the last part of the story.');
    const max=long?24:12,limit=long?56000:17000;
    // Reusable cast and places: the newest parts first (what the story uses now), at most the continuity limit.
    const seen=new Map();for(const part of [...done].reverse())for(const x of part.project.assets||[])if(!seen.has(x.id))seen.set(x.id,x);
    const assets=[...seen.values()].filter(x=>current.media?.[x.id]?.blob?.size&&/^[a-f0-9]{64}$/.test(current.media[x.id]?.sha256||'')).slice(0,max).sort((a,b)=>a.id.localeCompare(b.id)).map(x=>({id:x.id,imagePrompt:x.imagePrompt}));
    // A "Direct scene frames" story has no reference pictures at all (owner 2026-11-18: "Continue the story" refused every such
    // story); it continues like its Part 2 and 3 did, with the cast's written looks. Only a story that had references needs them.
    if(seen.size&&!assets.length)throw Error('Approved reusable asset images are missing.');
    const looksByName=new Map();for(const c of [...done].reverse().flatMap(x=>x.project.castLooks||[]))if(!looksByName.has(c.name.toLowerCase()))looksByName.set(c.name.toLowerCase(),c);
    const ending='FINAL VISIBLE STATE / ENDING OF SEASON '+(season-1)+':\n'+current.project.scenes.at(-1).videoPrompt.split(/\nAUDIO\s*[—-]/)[0].slice(-3500);
    const lines=(x,short)=>{const all=x.project.scenes.map(sc=>sc.id+': '+sc.speech);return short&&all.length>6?[...all.slice(0,3),'…',...all.slice(-3)]:all;};
    const partText=(x,short)=>'PART '+(x.setup.partNumber||1)+' — '+x.project.title+'\n'+lines(x,short).join('\n');
    let story='SEASON '+(season-1)+' — '+(done[0].project.title||'')+' (finished; its main conflict was resolved):\n'+done.map(x=>partText(x,false)).join('\n\n');
    if(story.length+ending.length>limit*0.75)story='SEASON '+(season-1)+' — '+(done[0].project.title||'')+' (finished; its main conflict was resolved):\n'+done.map((x,i)=>partText(x,i<done.length-1)).join('\n\n');
    story=story.slice(0,Math.max(2000,Math.floor(limit*0.75)-ending.length));
    // The recap this season started from (Season 3+): the newest end of it is kept.
    const earlier=String(done[0].setup.season>1&&done[0].setup.continuation?done[0].setup.continuation.summary:'');
    const room=limit-story.length-ending.length-40,recap=earlier&&room>500?'EARLIER SEASONS (recap):\n'+earlier.slice(-room)+'\n\n':'';
    const summary=(recap+story+'\n'+ending).slice(0,limit);
    const notes=String(options.notes||'').replace(/\s+/g,' ').trim().slice(0,600);
    const topic='CONTINUE THE STORY — SEASON '+season+'. The earlier story in continuation.summary is finished and its main conflict was resolved. Write the next chapter with the same characters, starting after that ending (a later day, week or year is fine): a NEW main conflict with new stakes that grows out of what happened, never undoing, repeating or re-resolving the earlier ending. Scene 1 opens on a strong new hook and briefly makes clear where everyone stands now. Reuse the existing characters, outfits, places and props exactly by their asset IDs; add new characters only when the new chapter needs them.'
      +(Number(total)>1?' This season has '+total+' parts: this is Part 1 of '+total+'.':' This season is one complete episode that closes its own conflict.')
      +(notes?' CREATOR NOTES FOR THIS SEASON (what viewers want next; follow them while keeping the same characters, looks and continuity): '+notes:'');
    const {continuation,piece,...base}=current.setup;
    return validateSetup({...base,topicMode:'Existing topic',topic,partNumber:1,partsTotal:total,season,continuation:{previousPartNumber:0,sceneDuration:current.setup.sceneDuration,summary,voice:current.project.voice,assets,...(looksByName.size?{castLooks:[...looksByName.values()].slice(0,24)}:{})}});
  }
  function partAction(setup){const number=Number(setup.partNumber||1),total=Number(setup.partsTotal||1);if(!isDrama(setup.niche)||number>=total||number>=(isLong(setup)?4:3))return null;return {label:'Continue to Part '+(number+1)+' →'};}
  // Owner 2026-11-06: an edited narration goes into the video prompt too. The narration lives in the prompt as quoted
  // lines ("…"/“…”) spread over the timed shots; the run of quotes that spells the old narration is found and the new
  // words are shared out over the same quotes in proportion to their old length (cut at a sentence end or comma when one
  // is near), so each line stays in its shot. A prompt without the narration (AI narrator: visual-only) is left as is.
  function speechEditPrompt(scene,newSpeech){
    const next=String(newSpeech||'').replace(/\s+/g,' ').trim(),old=String(scene?.speech||'').replace(/\s+/g,' ').trim(),prompt=String(scene?.videoPrompt||'');
    if(/["“”]/.test(next))throw Error('Remove the quotation marks from the narration: the video prompt uses them to mark the spoken lines.');
    if(next===old)return {videoPrompt:prompt,changed:false};
    const letters=s=>s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
    const quotes=[...prompt.matchAll(/(["“])([^"”]+)(["”])/g)].map(m=>({start:m.index,end:m.index+m[0].length,open:m[1],close:m[3],text:m[2]}));
    let run=null;
    if(old)for(let i=0;i<quotes.length&&!run;i++){let joined='';for(let j=i;j<quotes.length;j++){joined+=letters(quotes[j].text);if(joined===letters(old)){run=quotes.slice(i,j+1);break;}if(!letters(old).startsWith(joined))break;}}
    if(!run){
      if(!old||!quotes.length||!quotes.some(q=>letters(old).includes(letters(q.text))&&letters(q.text).length>3))return {videoPrompt:prompt,changed:false};
      throw Error('The old narration could not be found word for word in the video prompt, so it was not changed there. Edit the spoken lines in the Video prompt too.');
    }
    if(!next)throw Error('The narration is empty. Remove the spoken lines from the Video prompt instead, or write the new words.');
    const words=next.split(' '),weights=run.map(q=>Math.max(1,q.text.trim().split(/\s+/).length)),total=weights.reduce((a,b)=>a+b,0);
    if(words.length<run.length){const parts=run.map((_,i)=>i<words.length?words[i]:'');return {videoPrompt:rebuild(prompt,run,parts),changed:true};}
    const parts=[];let from=0,used=0;
    run.forEach((q,i)=>{
      if(i===run.length-1){parts.push(words.slice(from).join(' '));return;}
      used+=weights[i];let cut=Math.round(words.length*used/total);
      cut=Math.min(Math.max(cut,from+1),words.length-(run.length-1-i));
      // Prefer a cut right after a sentence end, then after a comma, within 3 words.
      for(const mark of [/[.!?…]$/,/[,;:]$/]){const near=[0,-1,1,-2,2,-3,3].map(d=>cut+d).find(c=>c>from&&c<=words.length-(run.length-1-i)&&mark.test(words[c-1]));if(near){cut=near;break;}}
      parts.push(words.slice(from,cut).join(' '));from=cut;
    });
    return {videoPrompt:rebuild(prompt,run,parts),changed:true};
    function rebuild(text,spans,texts){let out='',at=0;spans.forEach((q,i)=>{out+=text.slice(at,q.start)+(texts[i]?q.open+texts[i]+q.close:'');at=q.end;});return out+text.slice(at);}
  }
  // Owner 2026-11-06: a saved Video → Story project can be remade in another look. The look lives in one fixed style line
  // (the [STYLE LINE] wording of server/faceless-skill/references/niches/tagalog-drama.md) that opens every card, start frame
  // and video OUTPUT line, plus a short end tag on the cards. Both are swapped; camera-only words (white balance in Kelvin,
  // lens millimetres, film grain, DSLR) become plain light words for drawn/rendered looks. Story, lines and shots stay.
  const RESTYLE={
    'Photorealistic cinematic':{line:'photorealistic cinematic live-action photograph (natural skin texture, real locations)',tag:'Photorealistic.',photo:true},
    'Stylized 3D':{line:'premium stylized 3D animated-film render (Pixar-quality animated movie look, stylized characters and materials; not a photograph, not live action)',tag:'Stylized 3D render, not a photograph.'},
    'Anime':{line:'hand-drawn 2D anime illustration (clean ink line art, flat cel shading, anime eyes and facial features, painted anime background; not a photograph, not photorealistic, not 3D)',tag:'2D anime illustration, not a photograph.'},
    'Flat illustration':{line:'flat 2D vector illustration (clean shapes, flat colors, bold outlines, minimal shading; not a photograph, not 3D)',tag:'Flat 2D vector illustration, not a photograph.'},
    'Painterly':{line:'painterly digital painting (visible brush strokes, painted textures, soft atmospheric depth; not a photograph, not 3D)',tag:'Painterly digital painting, not a photograph.'}};
  const RESTYLE_LABELS={'Photorealistic cinematic':'Photorealistic','Stylized 3D':'3D animated','Anime':'2D anime','Flat illustration':'Flat 2D','Painterly':'Painterly'};
  function restyleOptions(setup){return reverseVideo(setup)?Object.keys(RESTYLE).filter(s=>s!==(setup.style||'Photorealistic cinematic')).map(value=>({value,label:RESTYLE_LABELS[value]})):[];}
  function restyleProject(project,setup,style){
    if(!reverseVideo(setup))throw Error('Only Video → Story projects can change their look.');
    const from=RESTYLE[setup.style||'Photorealistic cinematic'],to=RESTYLE[style];
    if(!from)throw Error('This project uses a look that cannot be swapped ('+setup.style+').');
    if(!to)throw Error('Choose one of: '+Object.keys(RESTYLE).join(', ')+'.');
    if(to===from)throw Error('The project already uses this look.');
    const MARK='\u0000STYLE\u0000',escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const kelvin=k=>k<4000?'warm light':k<=5200?'neutral light':'cool daylight';
    let missing=0;
    const swap=(text,lead)=>{
      let t=String(text||'');if(!t)return t;
      const had=t.includes(from.line);t=t.split(from.line).join(MARK);
      t=t.replace(new RegExp('(^|\\s)'+escape(from.tag)+'(?=\\s|$)','g'),'$1'+to.tag);
      if(!to.photo)t=t.replace(/\bWB\s*(\d{4,5})\s*K\b/gi,(_,k)=>kelvin(Number(k))).replace(/,?\s*\b\d{2,3}\s?mm(?:\s+lens)?\b/gi,'').replace(/,?\s*\b(?:film grain|DSLR)\b/gi,'');
      t=t.split(MARK).join(to.line);
      if(!had&&lead){missing++;t='STYLE: '+to.line+'. '+t;}
      return t;
    };
    const next={...setup,style},copy=structuredClone(project);
    for(const a of copy.assets)a.imagePrompt=swap(a.imagePrompt,true);
    for(const s of copy.scenes){s.imagePrompt=swap(s.imagePrompt,true);s.videoPrompt=swap(s.videoPrompt,true);}
    const label=RESTYLE_LABELS[style];
    copy.title=String(copy.title||'Video rebuild').replace(/ · (?:Photorealistic|3D animated|2D anime|Flat 2D|Painterly)$/,'')+(to.photo?'':' · '+label);
    return {project:validateProject(copy,next),setup:next,missing,label};
  }
  // Video → Story parts share their people (owner 2026-11-07): all parts of one rebuild are saved at once, before any
  // picture exists, so Part 2 made its character sheets again. A part now takes the sheet another part of the same
  // rebuild already has: same asset id and the very same prompt. Change look copies count as one rebuild per look
  // (original rebuild + the copy's style), also for copies made before this fix. Returns {assetId: sourceProjectId}.
  function reverseShared(p,all,{replace=false}={}){
    const byId=new Map((all||[]).map(x=>[x.id,x]));
    const rootOf=x=>{for(let i=0;x?.restyledFrom&&byId.has(x.restyledFrom)&&i<12;i++)x=byId.get(x.restyledFrom);return x;};
    const group=x=>{const r=rootOf(x);return r?.reverseBatchId?r.reverseBatchId+'|'+(x.restyledFrom&&r!==x?x.setup?.style||'':''):null;};
    const key=group(p),out={};if(!key||!p.project?.assets?.length)return out;
    const others=(all||[]).filter(x=>x.id!==p.id&&x.kind==='project'&&x.project&&group(x)===key).sort((a,b)=>(a.reversePart||0)-(b.reversePart||0)||(a.createdAt||0)-(b.createdAt||0));
    for(const a of p.project.assets){
      if(p.media?.[a.id]&&!replace)continue;
      const src=others.find(x=>x.media?.[a.id]?.blob&&!(x.redoIds||[]).includes(a.id)&&x.project.assets.some(b=>b.id===a.id&&b.imagePrompt===a.imagePrompt));
      if(src&&src.media[a.id].sha256!==p.media?.[a.id]?.sha256)out[a.id]=src.id;
    }
    return out;
  }
  return {FLOW_VIDEO_MODEL,FLOW_RETIRE_AT,flowModelLeaving,currentFlowModel,flowVideoModels,flowModelLabel,reverseShared,speechEditPrompt,restyleProject,restyleOptions,RESTYLE_LABELS,NARRATION_OPTIONS,narrationEligible,VERSION,LONG_SCENES,LANGUAGES,DRAMA_COUNTRIES,compatibleLanguageSetup,ANIME_DRAMA_LOOK,ANIME_STORIES,isWorldDrama,languagesFor,countryLanguage,storyCulture,spokenWords,spokenScript,sameScript,joinNoSpaceWords,isDrama,isFormatNiche,isLong,pieceSizes,steps,validateSetup,validateProject,sceneHeading,validateSceneHeading,normalizeLegacySceneHeadings,healFlowTags,schema,topicSchema,validateTopics,hookSchema,validateHooks,outlineSchema,validateOutline,videoPlan,flowName,generationTargets,nextPartSetup,partAction,seasonAction,nextSeasonSetup,storyFinished};
});
