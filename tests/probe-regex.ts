import { HarmonyNoiseFilter } from '../src/core/harmony-filter.js';

const f = new HarmonyNoiseFilter();
const a = f.feed('before content here. <|channel');
const b = f.feed('>thought\n<channel|> after content');
const c = f.flush();
console.log('a=', JSON.stringify(a));
console.log('b=', JSON.stringify(b));
console.log('c=', JSON.stringify(c));
console.log('total=', JSON.stringify(a + b + c));

// Probe regex directly
const STRUCTURAL = ['channel','message','end','start','im_start','im_end','tool_call'];
const NAMES = ['analysis','final','commentary','thought'];
const dre = new RegExp(`<\\|?channel\\|?>\\s*(?:${NAMES.join('|')})\\s*`, 'g');
console.log('regex source:', dre.source);
const test = '<|channel>thought\n<channel|> after content';
console.log('test stripped:', JSON.stringify(test.replace(dre, '')));
