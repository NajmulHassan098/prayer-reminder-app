// Curated post-prayer adhkar for the follow-up email footer.
//
// IMPORTANT (same rule as reminders.js / hadiths.js): verify each Arabic text,
// translation, and reference against a primary source (e.g. Hisn al-Muslim
// / sunnah.com) before going live — misquoting adhkar is not something to
// risk in outbound emails.
//
// One dhikr per prayer per day: seeded by day-of-year + prayer index so the
// five follow-up emails a day each show a different entry, and the set rotates
// daily. Deterministic — never random — so tests and re-sends agree.

const ADHKAR = [
  {
    arabic: "سُبْحَانَ اللَّهِ (٣٣) وَالْحَمْدُ لِلَّهِ (٣٣) وَاللَّهُ أَكْبَرُ (٣٤)",
    text: "Glory be to Allah (33), praise be to Allah (33), Allah is Greatest (34) — completing 100, followed by the declaration: Lā ilāha illa-Llāhu waḥdahu lā sharīka lah…",
    reference: "Sahih Muslim (ʿAlī ibn Abī Ṭālib)",
  },
  {
    arabic: "اللَّهُمَّ أَنْتَ السَّلَامُ وَمِنْكَ السَّلَامُ، تَبَارَكْتَ يَا ذَا الْجَلَالِ وَالْإِكْرَامِ",
    text: "O Allah, You are Peace and from You is peace. Blessed are You, O Owner of majesty and honour.",
    reference: "Sahih Muslim (Thawbān)",
  },
  {
    arabic: "أَعُوذُ بِكَلِمَاتِ اللَّهِ التَّامَّاتِ مِنْ شَرِّ كُلِّ شَيْطَانٍ وَحَمَّامَةٍ",
    text: "I seek refuge in the perfect words of Allah from the evil of every shayṭān and every evil eye.",
    reference: "Sahih al-Bukhari (Abū Hurayrah) — recite after each prayer",
  },
  {
    arabic: "اللَّهُمَّ مُصَرِّفَ الْقُلُوبِ صَرِّفْ قُلُوبَنَا عَلَى طَاعَتِكَ",
    text: "O Allah, Turner of hearts, turn our hearts toward Your obedience.",
    reference: "Sahih Muslim (Anas ibn Mālik)",
  },
  {
    arabic: "اللَّهُمَّ أَعِنِّي عَلَى ذِكْرِكَ وَشُكْرِكَ وَحُسْنِ عِبَادَتِكَ",
    text: "O Allah, help me to remember You, to thank You, and to worship You in the best manner.",
    reference: "Sunan Abī Dāwūd & Sunan an-Nasāʾī (Muʿādh ibn Jabal)",
  },
  {
    arabic: "لَا إِلَهَ إِلَّا اللَّهُ وَحْدَهُ لَا شَرِيكَ لَهُ، لَهُ الْمُلْكُ وَلَهُ الْحَمْدُ وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ",
    text: "There is no god but Allah alone, with no partner; His is the dominion and His is the praise, and He is over all things capable. (Ten times after Fajr and Maghrib.)",
    reference: "Sahih al-Bukhari & Sahih Muslim (Ibn ʿAbbās / Abū Ayyūb)",
  },
  {
    arabic: "حَسْبِيَ اللَّهُ لَا إِلَهَ إِلَّا هُوَ عَلَيْهِ تَوَكَّلْتُ وَهُوَ رَبُّ الْعَرْشِ الْعَظِيمِ",
    text: "Allah is sufficient for me; there is no god but Him. In Him I put my trust, and He is the Lord of the Mighty Throne. (Seven times morning and evening.)",
    reference: "Sunan Abī Dāwūd (Abū al-Dardāʾ)",
  },
  {
    arabic: "بِسْمِ اللَّهِ الَّذِي لَا يَضُرُّ مَعَ اسْمِهِ شَيْءٌ فِي الْأَرْضِ وَلَا فِي السَّمَاءِ وَهُوَ السَّمِيعُ الْعَلِيمُ",
    text: "In the name of Allah, with whose name nothing on earth or in the sky can cause harm, and He is the All-Hearing, the All-Knowing. (Three times morning and evening.)",
    reference: "Sahih al-Bukhari & Sahih Muslim (ʿUthmān ibn ʿAffān)",
  },
];

function adhkarForDay(prayerIndex, dateStr) {
  const parts = String(dateStr || "").split("-").map(Number);
  const seed = parts.length === 3 ? (parts[1] * 37 + parts[2]) : new Date().getDay();
  return ADHKAR[(seed + prayerIndex) % ADHKAR.length];
}

module.exports = { ADHKAR, adhkarForDay };
