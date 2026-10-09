// Curated, commonly-cited verses and hadith about Salah (prayer).
//
// IMPORTANT: These are well-known, widely-cited translations/references,
// but they were written from memory without live verification against a
// primary source. Before this goes live, please double-check the exact
// wording and citation against a trusted source such as
// https://quran.com or https://sunnah.com and correct anything that
// doesn't match precisely — misquoting scripture is not something to
// risk on a public-facing page.

const REMINDERS = [
  {
    type: "Quran",
    arabic: "إِنَّ الصَّلَاةَ تَنْهَىٰ عَنِ الْفَحْشَاءِ وَالْمُنكَرِ ۗ وَلَذِكْرُ اللَّهِ أَكْبَرُ",
    text:
      "Indeed, prayer prohibits immorality and wrongdoing, and the remembrance of Allah is greater.",
    reference: "Surah Al-Ankabut 29:45 (partial)",
  },
  {
    type: "Quran",
    arabic: "يَا أَيُّهَا الَّذِينَ آمَنُوا اسْتَعِينُوا بِالصَّبْرِ وَالصَّلَاةِ ۚ إِنَّ اللَّهَ مَعَ الصَّابِرِينَ",
    text:
      "O you who have believed, seek help through patience and prayer. Indeed, Allah is with the patient.",
    reference: "Surah Al-Baqarah 2:153",
  },
  {
    type: "Quran",
    arabic: "حَافِظُوا عَلَى الصَّلَوَاتِ وَالصَّلَاةِ الْوُسْطَىٰ وَقُومُوا لِلَّهِ قَانِتِينَ",
    text:
      "Guard strictly the (five obligatory) prayers, especially the middle prayer, and stand before Allah with obedience.",
    reference: "Surah Al-Baqarah 2:238 (paraphrased)",
  },
  {
    type: "Hadith",
    arabic: "أَوَّلُ مَا يُحَاسَبُ بِهِ الْعَبْدُ يَوْمَ الْقِيَامَةِ الصَّلَاةُ، فَإِنْ صَلُحَتْ صَلُحَ سَائِرُ عَمَلِهِ، وَإِنْ فَسَدَتْ فَسَدَ سَائِرُ عَمَلِهِ",
    text:
      "The first matter that the slave will be brought to account for on the Day of Judgment is the prayer. If it is sound, the rest of his deeds will be sound, and if it is defective, the rest of his deeds will be defective.",
    reference: "Reported in Jami' at-Tirmidhi (graded Hasan)",
  },
  {
    type: "Hadith",
    arabic: "أَرَأَيْتُمْ لَوْ أَنَّ نَهْرًا بِبَابِ أَحَدِكُمْ يَغْتَسِلُ مِنْهُ كُلَّ يَوْمٍ خَمْسَ مَرَّاتٍ، هَلْ يَبْقَى مِنْ دَرَنِهِ شَيْءٌ؟",
    text:
      "The five daily prayers are like a river flowing at the door of one of you in which he washes five times a day — would any dirt remain on him?",
    reference: "Reported in Sahih al-Bukhari & Sahih Muslim (paraphrased)",
  },
  {
    type: "Hadith",
    arabic: "بَيْنَ الرَّجُلِ وَبَيْنَ الشِّرْكِ وَالْكُفْرِ تَرْكُ الصَّلَاةِ",
    text:
      "Between a man and disbelief is the abandonment of prayer.",
    reference: "Reported in Sahih Muslim",
  },
];

// Returns one reminder, rotating by day-of-year so it changes daily
// but stays the same for everyone visiting on the same day.
function reminderOfTheDay() {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000
  );
  return REMINDERS[dayOfYear % REMINDERS.length];
}

module.exports = { REMINDERS, reminderOfTheDay };
