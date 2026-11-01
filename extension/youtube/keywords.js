// Rudder's first and strictest check, no model needed: does the title or channel contain a filter's words, or words
// closely tied to them? A match hides the video at once (before the model is even loaded). Strict on purpose: some
// harmless videos get hidden, but a video that names what a filter describes never gets through on a model's mistake.
//
// A filter sentence is split into alternatives at "or", "/" and commas ("poor people or rich people" → poor | rich).
// Each alternative's content words must ALL appear (so "video game music" needs a game word AND a music word), each
// word matching itself or its plural/verb forms, or any word listed for it below (as written). Words ending in -ly ("creepishly")
// only colour the meaning, so they aren't required.

const STOP = new Set(("a an and the of to in on for with by at from as is are was were be been being it its this that " +
  "these those any anything something everything stuff thing things content video videos related relating about " +
  "implying imply involving regarding can could would should may might will deemed considered my me i you your our " +
  "just very really kind sort like type types inducing induce ruin ruins ruining get gets make makes putting put " +
  "people person company companies someone somebody more most less some all").split(" "));

// Related words, keyed by a filter word (or its stem). "a_b" is a phrase (whole words, in order); "@key" pulls in
// another entry's words.
const RELATED = {
  death: "die dies died dead death deaths dying passed_away killed kill kills killing murder murdered obituary rip funeral tragedy tragic fatal fatally loses_battle_with mourn mourns mourning tribute in_memoriam rest_in_peace thank_you_for_everything",
  die: "@death", dead: "@death", dying: "@death",
  war: "war wars warfare invasion invade invades invaded missile missiles airstrike airstrikes troops military army soldiers bomb bombing bombs frontline conflict ukraine russia gaza israel hamas nato nuclear terror terrorist terrorists terrorism hostage hostages",
  violence: "violence violent attack attacks attacked shooting shootings stabbing stabbed assault assaulted fight fights brawl brutal beaten beating kill killed killing murder murdered gun guns weapon weapons blood bloody riot riots bare_knuckle",
  violent: "@violence",
  news: "news breaking_news headlines bbc_news cnn itv_news msnbc reuters sky_news fox_news abc_news nbc_news cbs_news the_guardian telegraph al_jazeera associated_press france_24 euronews channel_4 gb_news daily_mail newsnight 60_minutes south_china_morning_post scmp north_korea north_korean defectors",
  depressing: "depressing depressed depression sad sadness tragic tragedy heartbreaking heartbroken devastating devastated grief grieving mourning died dies dead death killed cancer suicide lonely loneliness hopeless crisis disaster collapse layoffs laid_off fired recession disabled disability down_syndrome wheelchair being_alone derealisation derealization dissociation worst_day cries crying cried in_tears breaks_down life_update",
  mood: "@depressing @angry @doom",
  sad: "@depressing",
  angry: "angry anger rage furious fury outrage outraged rant rants slams slammed destroys destroyed meltdown screaming yelling heated hate hates toxic",
  doom: "doom doomed doomer apocalypse collapse collapsing end_of_the_world extinction crisis catastrophe catastrophic disaster warning warns dire threat crash crashing recession nuclear is_cooked might_be_cooked is_dying actually_finished",
  gaming: "game games gaming gamer gamers gameplay playthrough walkthrough speedrun speedruns speedrunner esports esport twitch steam nintendo playstation ps5 ps4 xbox nintendo_switch switch_2 minecraft fortnite roblox valorant overwatch deadlock league_of_legends apex_legends call_of_duty gta pokemon zelda mario elden_ring dota cs2 counter_strike rainbow_six marvel_rivals tekken street_fighter smash_bros rpg fps mmo dlc patch_notes tier_list shooter shooters hero_shooter valve ost video_game_music k_da kda akali ahri evelynn kai'sa riot_games arcane jinx sega jsrf jet_set_radio ranked_up ranked_match ranked_games solo_queue elo sonic crush_40 toby_fox deltarune undertale clank resident_evil re9 re4 vinesauce jerma jerma985 angryjoe streamer streamers twitch_streamer gamedev game_dev devlog indie_game character_customization healing_reduction venator khaos_emerald chaos_emerald archmother powerspike power_spike mega_draft clash_royale character_guide fighting_souls maximilian_dood hideki_naganuma naganuma wii dmc dmc3 dmc5 devil_may_cry champ_select gragas yasuo yone teemo jhin thresh ezreal katarina vayne draven darius kayn viego aatrox zed kassadin malphite vyper infernus mcginnis vindicta viscous yamato holliday sinclair bebop lady_geist grey_talon aim_trainer kovaak kovaaks swiss_stage worlds2026 worlds_2026 achievement_hunter rooster_teeth northernlion 2ndjerma lowtiergod low_tier_god necrit supertf eternus itch.io pharah fareeha oneyplays cyberpunk cyberware emulator emulators abrams bogur multiversus megagamecrushers gabe_newell blasphemous",
  game: "@gaming", games: "@gaming", gamer: "@gaming",
  overwatch: "overwatch ow2 mauga tracer genji kiriko junker_queen pharah fareeha",
  deadlock: "deadlock",
  ai: "ai a.i artificial_intelligence chatgpt gpt gpt-4 gpt-5 gpt-6 llm llms openai anthropic claude gemini deepseek copilot grok mistral llama midjourney stable_diffusion sora machine_learning neural_network agi chatbot chatbots benchmark benchmarks sam_altman altman",
  openai: "openai chatgpt gpt sam_altman sora",
  anthropic: "anthropic claude",
  gemini: "gemini bard deepmind google_ai google_gemini",
  model: "model models llm llms",
  benchmark: "benchmark benchmarks benchmarked",
  job: "job jobs hiring hired layoffs laid_off fired career careers employment unemployment unemployed recession workforce internship internships intern interns jane_street quant",
  employment: "@job", unemployment: "@job",
  shooter: "shooter shooters fps",
  hero: "hero heroes",
  mean: "mean meanest rude insult insults bully bullying roast roasted",
  motivation: "motivation motivational motivated grind grindset discipline hustle sigma mindset edit edits phonk procrastination procrastinate productivity productive self_improvement brain_rot dopamine_detox",
  motivational: "@motivation",
  coding: "coding code coder programming programmer developer developers software_engineer javascript typescript python rust golang leetcode web_dev devops github compiler compilers c++ c# zig linux kernel software andrew_kelley shader shaders hlsl glsl touchdesigner quickshell hyprland neovim dotfiles goto_conferences unit_tests thatguycodes vibe-versioning vibe_coding tsoding data_structures codesmith",
  code: "@coding", programming: "@coding", developer: "@coding",
  engineer: "engineer engineers engineering",
  stock: "stock stocks stock_market shares nasdaq s&p dow_jones invest investing investment investor trading trader crypto bitcoin wall_street",
  future: "future futures next_decade",
  tech: "tech technology big_tech apple google microsoft meta amazon samsung nvidia intel amd tesla openai iphone android macbook silicon_valley elon_musk musk tsmc ddr5 ddr4 gpu gpus graphics_card pc_build",
  hack: "hacker hackers hacked hacking breach breached exploit exploits malware ransomware cyber cybersecurity security vulnerability",
  cyber: "@hack", security: "@hack", secuirty: "@hack",
  offensive: "offensive offended offend controversial slur slurs racist racism sexist sexism insult insults",
  poor: "poor poverty homeless broke",
  rich: "rich richest wealthy billionaire billionaires millionaire luxury",
  music: "music song songs soundtrack ost theme remix",
  valve: "valve steam",
  league: "league league_of_legends",
  politics: "politics political politician politicians election elections vote voting voter ballot campaign congress senate parliament government minister prime_minister president presidential white_house downing_street trump biden harris obama vance starmer sunak farage reform_uk labour tories tory conservatives democrat democrats republican republicans maga brexit policy protest protests zelensky zelenskyy putin kremlin elites hegseth rfk desantis newsom",
  election: "@politics", politician: "@politics", political: "@politics",
  crime: "crime crimes criminal criminals arrested arrest police cops jail prison prisoner sentenced trial court lawsuit sued fraud robbery robbed theft stolen heist kidnapped kidnapping missing_person true_crime serial_killer cartel gang gangs mugshot convicted guilty",
  scam: "scam scams scammer scammers scammed fraud con_artist pyramid_scheme ponzi",
  disaster: "disaster disasters earthquake hurricane tornado flood floods flooding wildfire wildfires tsunami explosion exploded derailed derailment plane_crash car_crash accident accidents emergency emergencies evacuated evacuation collapse collapsed sinking sank stampede stampeding overcrowded ambulance",
  accident: "@disaster", emergency: "@disaster",
  illness: "illness ill sick sickness disease diseases cancer tumor tumour virus pandemic covid outbreak hospital hospitalised hospitalized diagnosis diagnosed terminal surgery heart_attack dementia alzheimer alzheimers chemo stroke burns scar scars injury injuries injured wound wounds burn_victim severe_burns",
  disease: "@illness", health: "@illness",
  scare: "scare scares scary scared",
  drama: "drama dramas controversy controversial exposed exposing expose diss cancelled canceled apology apologizes apologises scandal allegations accused feud callout big_brother celebrity_big_brother cbb h3 h3h3 ethan_klein responded situation we_need_to_talk is_finished actually_finished feuds breaks_down storms_out walks_out cbb17 beef_with",
  controversy: "@drama", exposed: "@drama",
  bait: "bait ragebait rage_bait clickbait shocking gone_wrong you_won_t_believe",
  clickbait: "@bait",
  scary: "scary horror creepy creepiest haunted haunting ghost ghosts paranormal demon demonic nightmare terrifying disturbing gore gory jumpscare jumpscares creepypasta",
  horror: "@scary", disturbing: "@scary",
  diet: "diet diets dieting calories calorie ozempic weight_loss lose_weight lost_weight fat skinny body_image looksmaxxing looksmaxing glow_up plastic_surgery bmi fake_muscles natty fake_natty steroids",
  weight: "weight_loss lose_weight lost_weight overweight",
  body: "body_image body_shaming",
  conspiracy: "conspiracy conspiracies illuminati flat_earth cover_up coverup propaganda hoax",
  culture: "woke anti-woke culture_war culture_wars feminism feminist redpill red_pill manosphere",
  animal: "animal animals dog dogs puppy puppies cat cats kitten kittens pet pets horse wildlife",
  cruelty: "cruelty abuse abused abandoned starving neglected injured put_down euthanized euthanised suffering",
  suffering: "suffering suffer suffers agony",
  breakup: "breakup breakups broke_up divorce divorced cheating cheated cheater affair red_flags",
  cheat: "@breakup",
  toxic: "toxic",
  relationship: "relationship relationships dating boyfriend girlfriend husband wife marriage",
  climate: "climate climate_change global_warming pollution polluted emissions heatwave drought carbon",
  pollution: "@climate",
  // relapse triggers
  alcohol: "alcohol alcoholic beer beers wine wines vodka whiskey whisky tequila rum gin cocktail cocktails drunk drinking hangover booze liquor champagne prosecco lager ipa brewery pub pubs pub_crawl bar_crawl nightclub partying",
  drink: "@alcohol",
  drug: "drug drugs weed cannabis marijuana thc cbd edibles stoned cocaine heroin meth fentanyl opioid opioids pills xanax adderall lsd magic_mushrooms shrooms psychedelic psychedelics ketamine mdma molly ecstasy overdose dealer 420 lean codeine breaking_bad",
  cigarette: "cigarette cigarettes cigar cigars nicotine tobacco smoking smoker smokers zyn snus juul",
  vaping: "vape vapes vaping vaper elf_bar",
  gambling: "gambling gamble gambler casino casinos slots slot_machine poker blackjack roulette betting bet bets bookie parlay parlays sportsbook stake lottery scratch_cards loot_box loot_boxes gacha case_opening case_battle crypto day_trading options_trading forex memecoin",
  betting: "@gambling", casino: "@gambling", bet: "@gambling",
  sexual: "sexual sex sexy nsfw onlyfans porn nude nudes naked thirst_trap lingerie stripper seductive erotic hookup 18+ butt buts booty twerk twerking thicc",
  suggestive: "@sexual",
  binge: "binge binging bingeing binge_eating",
  junk: "junk_food fast_food mukbang mukbangs mcdonalds mcdonald burger_king kfc taco_bell pizza candy sweets donuts calorie_challenge 10,000_calorie chopped_cheese sticks_of_butter stick_of_butter",
  food: "@junk",
  challenge: "challenge challenges",
  shopping: "shopping haul hauls unboxing unboxings spree splurge amazon_finds temu shein black_friday cyber_monday deals buying",
  spending: "@shopping", haul: "@shopping",
  "self-harm": "self-harm self_harm selfharm suicide suicidal",
  suicide: "suicide suicidal",
  eating: "eating eat eats @disorder",
  disorder: "eating_disorder eating_disorders anorexia anorexic bulimia bulimic binge_eating",
  addiction: "addiction addicted addict addicts addictive relapse relapsed sober sobriety rehab addiction_recovery in_recovery recovery_journey withdrawal withdrawals detox cravings craving 12_step doomscrolling",
  relapse: "@addiction", withdrawal: "@addiction",
  cooking: "cooking cook cooks recipe recipes chef kitchen",
  baking: "baking bake baked baker bread cake cakes sourdough pastry",
};

const SAFE = ["star wars", "breaking character", "ground beef", "roast beef", "beef stew", "ghost costume", "ghost emoji"];
// NFKC turns "fancy" Unicode letters (𝕭𝖑𝖆𝖘𝖕𝖍𝖊𝖒𝖔𝖚𝖘, 𝐛𝐨𝐥𝐝, ｗｉｄｅ) into plain ones first
const words = (s) => (s.normalize("NFKC").toLowerCase().replace(/[’']s\b/g, "").match(/[a-z0-9&+.#-]+/g) ?? []).map((w) => w.replace(/^[.#-]+|[.-]+$/g, "")).filter(Boolean); // "#deadlock" is "deadlock"
// light stemming: plurals and verb endings ("news" isn't a plural: stemmed it matched every "new")
const NO_STEM = new Set(["news", "series", "species", "always", "less", "bias"]);
export function stem(w) {
  if (NO_STEM.has(w)) return w;
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}
function related(word, seen = new Set()) {
  const out = new Set([word]);
  for (const key of [word, stem(word)]) {
    if (seen.has(key) || !RELATED[key]) continue;
    seen.add(key);
    for (const r of RELATED[key].split(" ")) {
      if (r.startsWith("@")) for (const x of related(r.slice(1), seen)) out.add(x);
      else out.add(r);
    }
  }
  return out;
}

// each alternative of a filter: a list of slots; a slot is satisfied by any of its words (or their stems) or phrases
export function compile(sentence) {
  return sentence.toLowerCase().split(/\s*(?:,|\bor\b|\/)\s*/)
    .map((alt) => words(alt).filter((w) => !STOP.has(w) && w.length > 1 && !(w.length > 6 && w.endsWith("ly"))))
    .filter((ws) => ws.length)
    .map((ws) => ws.map((w) => {
      const all = [...related(w)], single = all.filter((r) => !r.includes("_"));
      // only the filter's own word is matched by stem; the related lists spell out their forms (stemming them too
      // made "beats" match "beating")
      return { word: w, single: new Set(single), stems: new Set([stem(w)]), phrases: all.filter((r) => r.includes("_")).map((r) => r.replaceAll("_", " ")) };
    }));
}
const cache = new Map();
// what matched (e.g. "dies" or "hero + shooters"), or null
export function keywordMatch(sentence, title, channel = "") {
  if (!cache.has(sentence)) cache.set(sentence, compile(sentence));
  let text = `${title ?? ""} ${channel ?? ""}`.normalize("NFKC").toLowerCase();
  for (const p of SAFE) text = text.replaceAll(p, " ");
  const tokens = words(text), stems = tokens.map(stem), flat = ` ${tokens.join(" ")} `;
  for (const alt of cache.get(sentence)) {
    const hits = [];
    for (const slot of alt) {
      const k = tokens.findIndex((t, i) => slot.single.has(t) || slot.stems.has(stems[i]));
      const hit = k >= 0 ? tokens[k] : slot.phrases.find((p) => flat.includes(` ${p} `));
      if (!hit) break;
      hits.push(hit);
    }
    if (hits.length === alt.length) return hits.join(" + ");
  }
  return null;
}
