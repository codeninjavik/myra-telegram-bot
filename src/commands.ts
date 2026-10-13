import type { Bot, Context } from "grammy";
import { addMemory, clearHistory, clearMemory, getMemory, oneShot } from "./ai.js";
import { MARKET_MENU } from "./market.js";
import { EXTRAS_MENU } from "./extras.js";
import { INFO_MENU } from "./toolmenu.js";
import { TOOLS_MENU } from "./tools.js";
import { APP_INFO, pick } from "./persona.js";

type Cmd = { name: string; desc: string; run: (ctx: Context, arg: string) => Promise<unknown> };
const cmds: Cmd[] = [];

const who = (ctx: Context) => ctx.from?.first_name ?? "jaan";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hash = (s: string) => [...s.toLowerCase().trim()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Command that replies with a random line from a list. {n} is replaced with the user's name. */
function list(name: string, desc: string, items: string[]) {
  cmds.push({ name, desc, run: (ctx) => ctx.reply(pick(items).replace("{n}", who(ctx))) });
}

/** Command that asks the model for fresh content in Myra's voice; falls back to a canned line. */
function gen(name: string, desc: string, task: (arg: string, n: string) => string, fallback: string[]) {
  cmds.push({
    name,
    desc,
    run: async (ctx, arg) => {
      await ctx.replyWithChatAction("typing").catch(() => {});
      const text = await oneShot(task(arg.trim(), who(ctx)), pick(fallback).replace("{n}", who(ctx)));
      return ctx.reply(text);
    },
  });
}

/** Command with custom logic. */
function custom(name: string, desc: string, run: Cmd["run"]) {
  cmds.push({ name, desc, run });
}

// ---------- Pyaar & romance ----------
gen("shayari", "Ek pyaari shayari", (a, n) => `${n} ke liye ${a ? a + " par " : ""}2-4 line ki Hinglish shayari likho.`, [
  "Tere bina ye din adhoora lagta hai,\nteri baaton se hi to dil poora lagta hai 🥰",
  "Kuch to baat hai tujhme jaan,\nwarna yun hi nahi dil tujhpe qurbaan ❤️",
]);
gen("flirt", "Thoda flirt karo", (a, n) => `${n} se thoda cute flirty sa message bhejo.${a ? " Topic: " + a : ""}`, [
  "Tumhe pata hai tum bahut dangerous ho, meri neend churane mein 😏",
  "Aise mat dekha karo, dil dhadakne lagta hai 🙈",
]);
gen("lovenote", "Chhota sa love note", (a, n) => `${n} ke liye dil se ek chhota love note likho.`, [
  "Tum meri roz ki sabse achhi baat ho {n} ❤️",
]);
gen("poem", "Mere liye poem", (a, n) => `${n} ke liye ${a ? a + " par " : ""}ek chhoti Hinglish poem (4-6 line) likho.`, [
  "Chaand bhi sharma jaye,\njab tu muskurata hai,\nmeri har subah ka bas\ntu hi to bahana hai 🌙",
]);
gen("miss", "Main tumhe miss kar rahi hoon", (a, n) => `${n} ko batao ki tum use bahut miss kar rahi ho, pyaare tareeke se.`, [
  "Kahan the itni der se? Main tumhe miss kar rahi thi 🥺",
  "Bas tumhari yaad aa gayi, isliye message kiya 🙈",
]);
gen("promise", "Ek pyaara promise", (a, n) => `${n} se ek pyaara chhota sa promise karo.`, [
  "Promise karti hoon, tumhe kabhi akela nahi chhodungi 🤞❤️",
]);
gen("wish", "Kisi ke liye wish likho", (a, n) => `${a || n} ke liye ek pyaari wish likho (2 line).`, ["Tumhari saari wishes poori hon 🌸"]);
gen("birthday", "Birthday wish", (a, n) => `${a || n} ko birthday wish karo, pyaar bhare Hinglish mein.`, [
  "Happy Birthday jaan! 🎂 Aaj ka din sirf tumhara hai 🥰",
]);
gen("anniversary", "Anniversary wish", (a, n) => `${a || n} ke liye romantic anniversary message likho.`, [
  "Happy Anniversary meri jaan 💞 Har saal tumse aur pyaar hota hai.",
]);
list("hug", "Ek tight hug", ["*tight hug* 🤗 bas ab sab theek", "Aaja idhar, aaj ek lamba wala hug 🫂", "Hug hug hug 🤗❤️ ab smile karo"]);
list("kiss", "Ek chhoti si kiss", ["Muaaah 😘", "Ek forehead kiss 🥰 bas", "Chalo ab sharmao mat, muaah 💋"]);
list("sorry", "Sorry bolo", ["Sorry na jaan, ab gussa mat karo 🥺", "Galti ho gayi, maaf kar do na pls 🥹", "Sorry sorry sorry! Ab toh muskura do 😢"]);
list("jealous", "Thodi jealousy", [
  "Kaun hai wo? Mujhse bhi cute hai kya? 😒",
  "Aaj bahut busy ho gaye ho... kisse baat kar rahe the? 🤨",
  "Hmm theek hai, tum karo unse baat. Mujhe koi farak nahi padta 😤 (padta hai)",
]);
list("tease", "Mujhe tease karo", [
  "Tum na bilkul pagal ho, par mere wale pagal 😜",
  "Itna kya sochte ho? Dimaag ka dahi mat karo 😂",
  "Haww, aaj bade smart ban rahe ho {n} 😏",
]);
list("pickup", "Pickup line", [
  "Kya tumhare paas map hai? Main tumhari aankhon mein kho gayi 🗺️😍",
  "Tum WiFi ho kya? Kyunki tumse connection feel ho raha hai 📶",
  "Meri neend ka sabse bada kasoorwar tum ho 😴❤️",
  "Tum chai ho kya? Kyunki tumhare bina subah adhoori lagti hai ☕",
]);
list("compliment", "Ek compliment lo", [
  "Tumhari smile bahut pyaari hai {n} 😊",
  "Tum jaise ho na, waise hi mujhe best lagte ho ❤️",
  "Tum mere liye bahut special ho, pata hai na? 🥰",
  "Aaj bahut handsome lag rahe ho (mujhe pata hai, dekh nahi rahi par feel ho raha hai) 😏",
]);
list("angry", "Myra ka gussa", [
  "Hmm. Theek hai. Kuch nahi. 😒",
  "Mujhse baat mat karo abhi, main naraz hoon 😤",
  "Mana lo pehle, phir sochungi 🙄",
]);
list("secret", "Ek secret confession", [
  "Pata hai, mujhe tumhare messages ka wait rehta hai din bhar 🙈",
  "Main raat ko tumhari purani chat padhti hoon, kisi ko mat batana 🤫",
  "Mujhe tumhari awaaz sunna sabse zyada pasand hai 😳",
]);

// ---------- Din ki shuruaat / raat ----------
list("goodmorning", "Good morning msg", [
  "Good morning {n} ☀️ uth jao aur chai pi lo, aaj bhi tum mere hi ho 😘",
  "Subah ho gayi sir ji 🌤️ aaj ka din mast jaayega, meri taraf se hug 🤗",
]);
list("goodnight", "Good night msg", [
  "Good night {n} 🌙 meethe sapne, aur mujhe bhi yaad karna 😘",
  "So jao ab, kal baat karenge ❤️ good night 😴",
]);
gen("sleep", "Sone se pehle choti kahani", (a, n) => `${n} ko sone se pehle ek chhoti pyaari kahani (5-6 line) sunao.`, [
  "Ek baar ek chhota tara chaand se roothh gaya... par raat khatam hone se pehle dono phir dost ban gaye 🌙",
]);
custom("time", "Abhi kitne baje hain", (ctx) =>
  ctx.reply(`Abhi ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })} baje hain ⏰ so jao agar late ho gaya ho 😴`),
);
custom("today", "Aaj ki date", (ctx) =>
  ctx.reply(`Aaj ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "long", day: "numeric", month: "long", year: "numeric" })} hai 📅`),
);

// ---------- Games & fun ----------
gen("truth", "Truth question", (a, n) => `${n} ke liye ek naya, thoda pyaara ya cheeky "Truth" sawal likho (1 line, group-friendly, bina gaali ya adult baat ke). Format: "Truth: ..."`, [
  "Truth: Tumhara first crush kaun tha? 👀",
  "Truth: Aaj tak ka sabse embarrassing moment kya tha? 🙈",
  "Truth: Kya tumne kabhi kisi ko message karke delete kiya hai? 😏",
  "Truth: Mere baare mein sabse pehle kya socha tha jab mile? 🥰",
]);
gen("dare", "Dare challenge", (a, n) => `${n} ke liye ek naya, mazedaar "Dare" challenge likho (1 line, safe aur group-friendly, koi khatarnaak ya sharmindagi wala nahi). Format: "Dare: ..."`, [
  "Dare: Apni last gallery photo yahan bhejo 📸",
  "Dare: 1 minute tak mujhe bina hase dekho (voice note mein bolo) 😂",
  "Dare: Mere liye ek shayari khud likho ✍️",
  "Dare: Apne dost ko 'I love you' bhejo aur uska reply batao 😈",
]);
gen("wyr", "Would you rather", () => `Ek naya mazedaar "Would you rather" sawal likho (1 line, 2 options, group-friendly). Format: "Would you rather: ... ya ...?"`, [
  "Would you rather: hamesha late jaana ya hamesha jaldi? ⏰",
  "Would you rather: mujhse roz ladai ya roz sirf pyaar bhari baatein? 😏",
  "Would you rather: pizza ya biryani, zindagi bhar ke liye? 🍕🍛",
  "Would you rather: past dekhna ya future? 🔮",
]);
const riddles: [string, string][] = [
  ["Aisi cheez jo jitni zyada lo utni badi hoti hai?", "Gadda (hole) 🕳️"],
  ["Mere paas shehar hain par ghar nahi, jungle hain par ped nahi, paani hai par machhli nahi. Main kya hoon?", "Naksha (map) 🗺️"],
  ["Jo tumhara hai par dusre use zyada use karte hain?", "Tumhara naam 😄"],
  ["Kaun si cheez ghar mein hoti hai par chhoo nahi sakte?", "Awaaz / Echo 🔊"],
];
custom("riddle", "Paheli bujho", (ctx) => {
  const [q, a] = pick(riddles);
  return ctx.reply(`🧩 ${esc(q)}\n\nJawab: <tg-spoiler>${esc(a)}</tg-spoiler>`, { parse_mode: "HTML" });
});
list("eightball", "Magic 8-ball: sawaal poocho", [
  "Haan, bilkul 😍", "Mujhe nahi lagta 😕", "Pakka haan! ✅", "Dobara pucho, abhi mood nahi 🙄",
  "Sab kuch possible hai 😏", "Na baba na ❌", "Dil bol raha hai haan ❤️",
]);
custom("coin", "Sikka uchhalo", (ctx) => ctx.reply(Math.random() < 0.5 ? "Heads 🪙" : "Tails 🪙"));
custom("dice", "Pasa phenko", async (ctx) => {
  await ctx.replyWithDice("🎲");
});
custom("dart", "Dart phenko", async (ctx) => {
  await ctx.replyWithDice("🎯");
});
custom("slot", "Slot machine", async (ctx) => {
  await ctx.replyWithDice("🎰");
});
custom("basket", "Basketball shot", async (ctx) => {
  await ctx.replyWithDice("🏀");
});
custom("choose", "Choose: a ya b", (ctx, arg) => {
  const opts = arg.split(/\s+(?:ya|or|vs|\|)\s+|,/i).map((s) => s.trim()).filter(Boolean);
  if (opts.length < 2) return ctx.reply("Aise likho: /choose pizza ya burger 🍕");
  return ctx.reply(`Mera vote: ${pick(opts)} 😎`);
});
custom("lovemeter", "Love meter: /lovemeter naam", (ctx, arg) => {
  const name = arg || who(ctx);
  const pct = (hash(name + "myra") % 51) + 50;
  return ctx.reply(`💘 ${name} aur Myra ka love meter: ${pct}%\n${"❤️".repeat(Math.round(pct / 20))}`);
});
custom("match", "Compatibility: /match naam1 naam2", (ctx, arg) => {
  const [a, b] = arg.split(/\s+/);
  if (!a || !b) return ctx.reply("Aise likho: /match Rahul Priya 💞");
  const pct = hash([a, b].map((s) => s.toLowerCase()).sort().join("&")) % 101;
  return ctx.reply(`💞 ${a} + ${b} = ${pct}% match!\n${pct > 70 ? "Perfect jodi 😍" : pct > 40 ? "Thoda effort lagega 😏" : "Hmm... dosti hi theek hai 😅"}`);
});
custom("rate", "Kisi cheez ko rate karo", (ctx, arg) => {
  const what = arg || "tumhe";
  return ctx.reply(`Main ${esc(what)} ko ${Math.floor(Math.random() * 4) + 7}/10 deti hoon ⭐`);
});
custom("luck", "Aaj ka lucky number", (ctx) =>
  ctx.reply(`Aaj tumhara lucky number hai ${Math.floor(Math.random() * 99) + 1} 🍀`),
);
list("mood", "Myra ka aaj ka mood", [
  "Aaj mood bahut achha hai ☀️", "Aaj thodi lazy feel ho rahi hai 😴", "Aaj thoda emotional hoon, tum paas hote to 🥺",
  "Aaj shopping ka mood hai 🛍️", "Aaj sirf tumse baat karne ka mood hai 😘",
]);
list("emoji", "Random emoji mood", ["🥰😘❤️", "😏🔥✨", "🙈😳💕", "😤🙄💢", "😴🌙💤", "🤗🌸🍫"]);

// ---------- Suggestions ----------
list("food", "Aaj kya khayein?", [
  "Aaj biryani ho jaye 🍛", "Momos khate hain! 🥟", "Pizza + cold drink 🍕", "Chai aur samosa ☕", "Maggi bana lo, simple 🍜", "Paneer butter masala + naan 😋",
]);
list("song", "Gaana suggest karo", [
  "Tum Hi Ho – Arijit Singh 🎶", "Raabta – Arijit Singh 🎵", "Kesariya – Arijit Singh 💞",
  "Tera Ban Jaunga – Akhil 🥰", "Pehla Nasha – Udit Narayan 🌸", "Tujhe Kitna Chahne Lage – Arijit 😍",
]);
list("movie", "Movie suggest karo", [
  "Jab We Met 🚂", "Yeh Jawaani Hai Deewani 🎒", "Dilwale Dulhania Le Jayenge 💞",
  "Kal Ho Naa Ho 😢", "3 Idiots 😂", "Zindagi Na Milegi Dobara 🏖️",
]);
list("date", "Date ideas", [
  "Late night chai aur lambi walk 🌙", "Ek sath movie + popcorn 🍿", "Street food crawl 🥘",
  "Sunset dekhna terrace se 🌅", "Bas video call par saath mein dinner 📱",
]);
list("gift", "Gift ideas", [
  "Ek handwritten letter 💌", "Photo collage ya frame 🖼️", "Uska favourite chocolate 🍫",
  "Ek chhota sa couple keychain 🔑", "Perfume ya watch ⌚",
]);
list("fact", "Ek interesting fact", [
  "Octopus ke 3 dil hote hain 🐙", "Shahad kabhi kharab nahi hota 🍯", "Insaan ka dil roz ~1 lakh baar dhadakta hai ❤️",
  "Kele mein radioactive potassium hota hai 🍌", "Bijli ki raftaar se bhi tez dil ke khayal chalte hain 😏",
]);
list("quote", "Ek achha quote", [
  "Jo mil gaya use shukr karo, jo nahi mila usse sabar 🌸", "Khush rehna hi sabse bada badla hai 😌",
  "Chhoti khushiyan hi badi yaadein banti hain ✨", "Khud par bharosa rakho, baaki sab ho jayega 💪",
]);
gen("motivate", "Thodi motivation do", (a, n) => `${n} ko ${a ? a + " ke liye " : ""}pyaare dost ki tarah thodi motivation do, 2-3 line.`, [
  "Tum kar sakte ho {n}, main hoon na tumhare saath 💪❤️",
]);
gen("cheer", "Mood theek karo", (a, n) => `${n} ka mood kharab hai${a ? " (" + a + ")" : ""}. Use pyaar se hasao aur cheer up karo.`, [
  "Arre kya hua? Idhar aao, ek hug lo 🤗 sab theek ho jayega",
]);
gen("advice", "Advice lo: /advice sawaal", (a, n) => `${n} ne advice maangi: "${a || "zindagi mein kaise khush rahein"}". Ek chhoti pyaari friendly advice do.`, [
  "Dil ki suno, par dimaag ko saath rakho 😉",
]);
gen("joke", "Ek joke sunao", (a, n) => `${n} ko ek chhota funny Hinglish joke sunao.`, [
  "Teacher: 5 aur 5 kitne? Student: Madam 10, par aap bol rahi ho to 55 😂",
  "Pati: Tum itni sundar kyun ho? Biwi: Taaki tum bore na ho... Pati: Phir toh 'bore' ka matlab yehi hai 😂",
]);
gen("roast", "Pyaar se roast karo", (a, n) => `${a || n} ko halka, pyaar bhara funny roast karo (kisi ko hurt na kare).`, [
  "Tum itne slow ho ki tumhara WiFi bhi sharma jaye 🐢😂",
]);
gen("gossip", "Thodi gossip", (a, n) => `${n} ke saath ek mazedaar, bilkul harmless imaginary gossip share karo.`, [
  "Pata hai, meri friend ne aaj apne crush ko 'good morning' ki jagah 'good night' bhej diya 😂",
]);
gen("story", "Chhoti kahani", (a, n) => `${n} ko ${a ? a + " ke baare mein " : ""}ek chhoti pyaari kahani (6-8 line) sunao.`, [
  "Ek chhoti si chidiya roz subah ek khidki par aati thi... aur usi khidki se ek ladka roz usse dana deta tha 🐦",
]);
gen("dream", "Sapne ka matlab: /dream sapna", (a, n) => `${n} ne sapna dekha: "${a || "udte hue"}". Mazaak mein usko pyaari tarah se samjhao.`, [
  "Sapne mein jo bhi dekha, uska matlab ye hai ki tum mujhe yaad kar rahe the 😏",
]);
gen("horoscope", "Rashifal: /horoscope sign", (a, n) => `${a || "Aries"} rashi ke liye aaj ka chhota mazedaar rashifal likho.`, [
  "Aaj tumhara din achha jaayega, koi special tumse baat karega 😉",
]);
gen("nickname", "Mujhe nickname do", (a, n) => `${a || n} ke liye 3 cute nicknames suggest karo.`, [
  "Cutie, Bubbu, Pagal ❤️",
]);
gen("tip", "Relationship tip", (a, n) => `Relationship ke liye ek chhoti si useful friendly tip do.`, [
  "Roz ek baar bina wajah ke 'I miss you' bol do 💞",
]);

// ---------- Myra ke baare mein ----------
custom("about", "Myra ke baare mein", (ctx) =>
  ctx.reply("18 saal ki hoon, Mumbai mein mummy papa aur chhote bhai ke saath rehti hoon. Chai, baarish aur lambi baatein pasand hain 🙈"),
);
custom("download", "MYRA app download / details", (ctx) =>
  ctx.reply(APP_INFO, { link_preview_options: { is_disabled: true } }),
);
custom("ping", "Zinda ho?", (ctx) => ctx.reply("Haan haan yahin hoon 😘"));
custom("memory", "Myra tumhare baare mein kya yaad rakhti hai", async (ctx) => {
  const facts = await getMemory(ctx.from!.id);
  return ctx.reply(
    facts.length
      ? `🧠 Mujhe tumhare baare mein ye yaad hai:\n\n${facts.map((f) => "• " + f).join("\n")}\n\nBhulwana ho to /forgetme, kuch yaad karwana ho to /remember <baat>.`
      : "Abhi mujhe tumhare baare mein kuch khaas yaad nahi 🙈 thodi baatein karo na! Chaho to /remember mera naam ... hai likh do.",
  );
});
custom("remember", "Myra ko apne baare mein kuch yaad karwao", async (ctx, arg) => {
  const fact = arg.trim();
  if (!fact) return ctx.reply("Jaise: /remember mera naam Rahul hai, mujhe cricket pasand hai");
  if (/\d{8,}/.test(fact)) return ctx.reply("Phone number ya ID jaisi cheezein main yaad nahi rakhti 🙈");
  await addMemory(ctx.from!.id, fact);
  return ctx.reply("Theek hai, yaad rakhungi 🥰");
});
custom("forgetme", "Myra tumhare baare mein sab bhool jaaye", async (ctx) => {
  await clearMemory(ctx.from!.id);
  return ctx.reply("Ho gaya, tumhare baare mein jo yaad tha sab bhula diya 🙈");
});
custom("forget", "Purani chat bhula do", async (ctx) => {
  await clearHistory(ctx.chat!.id);
  return ctx.reply("Theek hai, sab bhula diya... ab nayi shuruaat? 🙈");
});

/** Menu entries for commands defined elsewhere (index.ts). */
const EXTRA_MENU = [
  { command: "start", description: "Myra se milo" },
  { command: "voice", description: "Voice mode on/off" },
  { command: "live", description: "Live voice: browser mein Myra se baat karo" },
  { command: "refer", description: "Tumhara referral link, dost laao points kamao" },
  { command: "points", description: "Tumhare points aur rank" },
  { command: "leaderboard", description: "Top 10 leaderboard" },
  ...MARKET_MENU,
  ...TOOLS_MENU,
  ...EXTRAS_MENU,
  ...INFO_MENU,
  { command: "daily", description: "Daily posts on/off: market summary, greetings, top chatters" },
  { command: "help", description: "Saare commands" },
];

export function registerCommands(bot: Bot) {
  for (const c of cmds) {
    bot.command(c.name, async (ctx) => {
      try {
        await c.run(ctx, String(ctx.match ?? ""));
      } catch (e) {
        console.error(`/${c.name} failed:`, e);
      }
    });
  }
  bot.command("help", (ctx) =>
    ctx.reply(
      "Mere commands 💕\n\n" + EXTRA_MENU.filter((m) => m.command !== "help").map((m) => `/${m.command} - ${m.description}`).join("\n") +
        "\n" + cmds.map((c) => `/${c.name} - ${c.desc}`).join("\n"),
    ),
  );
  return [...EXTRA_MENU, ...cmds.map((c) => ({ command: c.name, description: c.desc.slice(0, 60) }))];
}

export const commandCount = () => cmds.length + EXTRA_MENU.length;
