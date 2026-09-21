import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code = fs.readFileSync(process.env.TRAFFIC_FILE || 'public/traffic.js', 'utf8');
const config = JSON.parse(code.match(/const site = (\{.*\});/)[1]);
function browser({host=config.hosts[0], dnt='0', gpc=false, search='', hash=''}={}) {
  const scripts=[];
  const context={window:{},location:{hostname:host,origin:`https://${host}`,href:`https://${host}/${search}${hash}`,search,hash},navigator:{doNotTrack:dnt,globalPrivacyControl:gpc,language:'en-US'},screen:{width:1024,height:768},URL,document:{getElementById:()=>null,createElement:()=>({setAttribute(k,v){this[k]=v}}),head:{appendChild(s){scripts.push(s)}}}};
  vm.runInNewContext(code,context);
  return {context,scripts,send:context.window.siteTrafficBeforeSend};
}
test('preview and native origins never load the collector',()=>{
 for(const host of ['localhost','127.0.0.1','preview.vercel.app',config.hosts[0]+'.evil.example']) assert.equal(browser({host}).scripts.length,0);
});
test('privacy preferences and recovery URLs prevent tracker loading',()=>{
 for(const options of [{dnt:'1'},{dnt:'yes'},{gpc:true},{search:'?token=private'},{search:'?reset-password&token=private'},{hash:'#access_token=private'}]) assert.equal(browser(options).scripts.length,0);
});
test('page payload drops private values and only allows known fields',()=>{
 const {send,scripts}=browser();
 assert.equal(scripts[0].referrerPolicy,'no-referrer');
 const result=send('event',{url:'/private/alice@example.com?token=secret#notes',title:'Personal journal',id:'user-email',data:{journal:'secret'},referrer:'https://search.example/results?email=private#secret'});
 assert.equal(result,null);
 const safe=send('event',{url:'/private/alice@example.com?campaign=secret',title:'Personal journal',id:'user-email',data:{journal:'secret'},referrer:'https://search.example/results?email=private#secret'});
 assert.equal(safe.url,'/other');assert.equal(safe.title,config.name);assert.equal(safe.referrer,'https://search.example');
 assert.deepEqual(Object.keys(safe).sort(),['website','hostname','url','title','referrer','language','screen'].sort());
 assert.ok(!JSON.stringify(safe).includes('secret'));assert.ok(!JSON.stringify(safe).includes('alice'));
});
test('custom events, identification and external URLs are discarded',()=>{
 const {send}=browser();
 for(const [type,payload] of [['identify',{id:'secret'}],['event',{name:'form',data:{email:'secret'}}],['event',{url:'https://evil.example/'}]]) assert.equal(send(type,payload),null);
});
test('a later privacy opt-out or authentication URL stops sends',()=>{
 const {send,context}=browser();context.location.search='?token=private';assert.equal(send('event',{url:'/'}),null);
 context.location.search='';context.navigator.globalPrivacyControl=true;assert.equal(send('event',{url:'/'}),null);
});
