const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const root = path.resolve(__dirname, '..') + path.sep;
const source = fs.readFileSync(root + 'script.js', 'utf8');
const nodes = {};
function node() {
  const classes = new Set(); let text = '';
  return { dataset: {}, style: {}, hidden: false, setAttribute() {},
    get textContent() { return text; }, set textContent(v) { text = String(v); },
    classList: { toggle(k,on) { on ? classes.add(k) : classes.delete(k); }, contains(k) { return classes.has(k); } } };
}
const context = { document: { getElementById(id) { return nodes[id] ||= node(); } } };
vm.createContext(context);
vm.runInContext(source.slice(0, source.indexOf('  const controller = new DashController();')) +
  'globalThis.x={CONFIG,Drivetrain,Simulator,Renderer,WarningRules,DashController,BASE_SAMPLE};})();', context);
const { CONFIG, Drivetrain, Simulator, Renderer, WarningRules, DashController, BASE_SAMPLE } = context.x;
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
check('separate 3500 colour / 6500 cue / 6800 official reference', () => {
  assert.equal(CONFIG.rpmColorRpm,3500); assert.equal(CONFIG.shiftRpm,6500); assert.equal(CONFIG.engineRedlineRpm,6800);
});
check('initial speed, selected gear and engine speed agree', () => {
  const s = new Simulator().sample(); assert.equal(s.gear,4);
  assert(Math.abs(s.rpm - s.speed * CONFIG.drivetrain.rpmPerKph[s.gear]) < 1e-8);
  assert.equal(s.coolant,92); assert.equal(s.voltage,13.8); assert.equal(s.oilTemp,95);
});
check('four scenarios bounded for 120 seconds and coupled RPM never invented', () => {
  for (const scenario of ['normal','spirited','oilDrop','hotOil']) {
    const sim = new Simulator(); sim.select(scenario);
    for (let i=0;i<6000;i++) {
      sim.advance(.02); const s=sim.sample();
      assert(s.rpm>=800&&s.rpm<=7000); assert(s.speed>=0&&s.speed<=180);
      assert(s.oilTemp>=90&&s.oilTemp<=130); assert(s.oilPressure>=1.5&&s.oilPressure<=5.5);
      if (s.coupled || s.gearCommitted) assert(Math.abs(s.rpm-Math.max(800,s.speed*CONFIG.drivetrain.rpmPerKph[s.gear]))<1e-7);
    }
  }
});
check('track cycle includes upshifts, downshifts and a real throttle/RPM blip', () => {
  const sim=new Simulator();sim.select('spirited');let last=sim.sample(),up=0,down=0,blip=0,cues=0;
  for(let i=0;i<4200;i++) {
    sim.advance(.02);const s=sim.sample();
    if(s.gear!==last.gear) {
      s.gear>last.gear?up++:down++;
      assert.equal(Math.abs(s.gear-last.gear),1);
      assert(Math.abs(s.rpm-s.speed*CONFIG.drivetrain.rpmPerKph[s.gear])<1e-7);
      assert(Math.abs(s.speed-last.speed)<.25);
    }
    if(s.driveState==='REV MATCH'&&s.throttle>60&&s.gear===last.gear&&s.rpm>last.rpm)blip++;
    if(s.rpm>=6500)cues++;
    last=s;
  }
  assert(up>=3&&down>=3&&blip>0&&cues>0);
});
check('upshift cuts throttle before new gear is selected', () => {
  const d=new Drivetrain(); d.gear=2; d.speed=97; d.rpm=d.rpmAt(d.speed,2);
  assert(d.requestShift(3)); d.update(.08,{targetSpeed:120,throttle:96,accelRate:7,brakeRate:11});
  assert.equal(d.gear,2);assert.equal(d.throttle,0);assert.equal(d.state,'UPSHIFT');
});
check('unsafe lower-gear request is rejected', () => {
  const d=new Drivetrain();d.gear=4;d.speed=130;d.rpm=d.rpmAt(d.speed,4);
  assert.equal(d.requestShift(2),false);assert.equal(d.gear,4);
});
check('normal stop reaches neutral and idle', () => {
  const sim=new Simulator();sim.advance(47);const s=sim.sample();assert.equal(s.gear,'N');assert.equal(s.speed,0);assert.equal(s.rpm,800);
});
check('manual slider RPM is exact and derives a compatible speed/gear', () => {
  const sim=new Simulator();sim.setManual({rpm:6500});const s=sim.sample();assert.equal(s.rpm,6500);
  assert(Math.abs(s.speed*CONFIG.drivetrain.rpmPerKph[s.gear]-6500)<1e-7);sim.advance(40);assert.equal(sim.sample().rpm,6500);
});
check('fault endpoints and warning boundaries survive the driving rewrite', () => {
  for(const [scenario,key,value] of [['oilDrop','oilPressure',1.5],['hotOil','oilTemp',130]]) {
    const sim=new Simulator();sim.select(scenario);sim.advance(24);assert.equal(sim.sample()[key],value);assert.equal(WarningRules.evaluate(sim.sample()).level,'critical');
  }
  assert.equal(WarningRules.classify('oilPressure',2),'yellow');assert.equal(WarningRules.classify('oilTemp',120),'yellow');
});
check('displayed gear and RPM synchronize; phase metadata does not get frozen', () => {
  const c=Object.create(DashController.prototype);c.display={...BASE_SAMPLE,speed:101,rpm:6400,driveState:'CRUISING'};
  c.target={...BASE_SAMPLE,gear:3,automaticDrive:true,coupled:false,gearCommitted:true,driveState:'DOWNSHIFT'};
  const s=c.quantizedSample();assert.equal(s.driveState,'DOWNSHIFT');assert.equal(s.gear,3);
  assert.equal(s.rpm,Math.round(101*CONFIG.drivetrain.rpmPerKph[3]/10)*10);
  c.target.gearCommitted=false;c.target.driveState='REV MATCH';assert.equal(c.quantizedSample().driveState,'REV MATCH');
});
const renderer=Object.create(Renderer.prototype);
Object.assign(renderer,{dash:node(),rpmNodes:[node()],speedNodes:[node()],gearNodes:[node()],rpmBars:[node()],progressPaths:[],needles:[],metricCards:[],lights:Array.from({length:10},node),rpmCaptions:[node(),node()],stateNodes:[node()],lightContainer:node(),shiftCallout:node(),alertTitle:node(),alertDetail:node(),alertLevel:node(),alertIcon:node(),lastWarningSignature:''});
function draw(rpm,extra={}) { const s={...BASE_SAMPLE,...extra,rpm};renderer.render(s,WarningRules.evaluate(s),'spirited',0,false); }
check('3500 is not a fault, strictly above it is red without full flash', () => {
  draw(3500);assert(!renderer.dash.classList.contains('rpm-high'));
  draw(3510);assert(renderer.dash.classList.contains('rpm-high'));assert(!renderer.dash.classList.contains('shift-flash'));assert.equal(renderer.dash.dataset.severity,'normal');
});
check('6500 cues whole screen, recovery clears it and rev match is visible', () => {
  draw(6500);assert(renderer.dash.classList.contains('shift-flash'));assert(!renderer.shiftCallout.hidden);
  draw(4800,{driveState:'REV MATCH'});assert(!renderer.dash.classList.contains('shift-flash'));assert.equal(renderer.stateNodes[0].textContent,'REV MATCH');
});
check('critical engine alert remains during high-RPM attention cue', () => {
  draw(6600,{oilPressure:1.5});assert.equal(renderer.dash.dataset.severity,'critical');assert(renderer.alertDetail.textContent.includes('油压过低'));
});
check('colour inversion and reduced-motion fallback are present', () => {
  const css=fs.readFileSync(root+'style.css','utf8');assert(css.includes('filter:invert(1)'));assert(css.includes('shift-negative-flash .65s'));assert(css.includes('animation:none!important;filter:invert(1)'));
});
console.log(checks+' transmission/display checks passed');
