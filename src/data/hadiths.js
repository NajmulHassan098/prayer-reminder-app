// Curated, commonly-cited hadith for the "Hadith of the day" widget.
//
// IMPORTANT (same rule as reminders.js): these are well-known wordings written
// from memory. Before going live, verify each text and reference against a
// primary source such as https://sunnah.com and correct anything that doesn't
// match precisely — misquoting hadith is not something to risk on a
// public-facing page.
//
// Rotation by day-of-year keeps one stable hadith per day for everyone; with
// 12 entries each one appears roughly monthly. Grow this list toward 30+
// verified entries so it becomes a true daily cycle.

const HADITHS = [
  {
    arabic: "إِنَّمَا الأَعْمَالُ بِالنِّيَّاتِ، وَإِنَّمَا لِكُلِّ امْرِئٍ مَا نَوَى",
    text: "Actions are only judged by intentions, and every person will have only what they intended.",
    reference: "Sahih al-Bukhari & Sahih Muslim (ʿUmar ibn al-Khaṭṭāb)",
  },
  {
    arabic: "مَنْ كَانَ يُؤْمِنُ بِاللَّهِ وَالْيَوْمِ الآخِرِ فَلْيَقُلْ خَيْرًا أَوْ لِيَصْمُتْ",
    text: "Whoever believes in Allah and the Last Day, let him speak good or remain silent.",
    reference: "Sahih al-Bukhari & Sahih Muslim (Abū Hurayrah)",
  },
  {
    arabic: "الدِّينُ النَّصِيحَةُ",
    text: "The religion is sincere counsel.",
    reference: "Sahih Muslim (Tamīm al-Dārī)",
  },
  {
    arabic: "خَيْرُكُمْ مَنْ تَعَلَّمَ الْقُرْآنَ وَعَلَّمَهُ",
    text: "The best of you are those who learn the Qur'an and teach it.",
    reference: "Sahih al-Bukhari (ʿUthmān ibn ʿAffān)",
  },
  {
    arabic: "الطُّهُورُ شَطْرُ الإِيمَانِ",
    text: "Purity is half of faith.",
    reference: "Sahih Muslim (Abū Mālik al-Ashʿarī)",
  },
  {
    arabic: "لَا يُؤْمِنُ أَحَدُكُمْ حَتَّى يُحِبَّ لأَخِيهِ مَا يُحِبُّ لِنَفْسِهِ",
    text: "None of you truly believes until he loves for his brother what he loves for himself.",
    reference: "Sahih al-Bukhari & Sahih Muslim (Anas ibn Mālik)",
  },
  {
    arabic: "الشَّهْرُ هَكَذَا وَهَكَذَا",
    text: "The month is like this and this — twenty-nine and thirty days. (Teaching us to fast by sighting, not assumption.)",
    reference: "Sahih al-Bukhari & Sahih Muslim (Ibn ʿUmar)",
  },
  {
    arabic: "مَنْ صَامَ رَمَضَانَ إِيمَانًا وَاحْتِسَابًا غُفِرَ لَهُ مَا تَقَدَّمَ مِنْ ذَنْبِهِ",
    text: "Whoever fasts Ramadan out of faith and hoping for reward, his previous sins will be forgiven.",
    reference: "Sahih al-Bukhari (Abū Hurayrah)",
  },
  {
    arabic: "كَلِمَتَانِ خَفِيفَتَانِ عَلَى اللِّسَانِ، ثَقِيلَتَانِ فِي الْمِيزَانِ، حَبِيبَتَانِ إِلَى الرَّحْمَنِ: سُبْحَانَ اللَّهِ وَبِحَمْدِهِ، سُبْحَانَ اللَّهِ الْعَظِيمِ",
    text: "Two words are light on the tongue, heavy on the scale, and beloved to the Most Merciful: Subḥāna-Llāhi wa-bi-Ḥamdih, Subḥāna-Llāhi-l-ʿAẓīm.",
    reference: "Sahih al-Bukhari & Sahih Muslim (Abū Hurayrah)",
  },
  {
    arabic: "مَا نَقَصَتْ صَدَقَةٌ مِنْ مَالٍ",
    text: "Charity never decreases wealth.",
    reference: "Sahih Muslim (Abū Hurayrah)",
  },
  {
    arabic: "مَنْ لَا يَشْكُرُ النَّاسَ لَا يَشْكُرُ اللَّهَ",
    text: "He who does not thank people has not thanked Allah.",
    reference: "Jāmiʿ at-Tirmidhī (Abū Hurayrah, graded Ṣaḥīḥ)",
  },
  {
    arabic: "يَسِّرُوا وَلَا تُعَسِّرُوا، وَبَشِّرُوا وَلَا تُنَفِّرُوا",
    text: "Make things easy and do not make them difficult; give glad tidings and do not repel.",
    reference: "Sahih al-Bukhari (Anas ibn Mālik)",
  },
];

// One hadith per day, rotating by day-of-year — same convention as
// reminderOfTheDay() in reminders.js so both stay stable within a day.
function hadithOfTheDay() {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000
  );
  return HADITHS[dayOfYear % HADITHS.length];
}

module.exports = { HADITHS, hadithOfTheDay };
