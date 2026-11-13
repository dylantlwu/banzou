package com.banzou.ktv

import java.text.Collator
import java.util.Locale

/**
 * v9 点歌页的筛选（全部 / 常点 / 语种 / 年代 / 歌手）。这里只有纯函数，不碰界面和文件，方便单独测。
 *
 * 一次只有一个筛选，用一个字符串表示：
 * `all`、`fav`、`lang:zh|yue|en|jk|other`、`dec:<年代原值，比如 90s / 更早>`、`art:<歌手名>`。
 * 老歌单（没有标签）里 lang / era 是空字符串：这种歌不属于任何语种、年代，相应的牌子不会出现。
 */
object Filters {
    const val ALL = "all"
    const val FAV = "fav"
    const val LANG = "lang:"
    const val DEC = "dec:"
    const val ART = "art:"
    /** 年代、歌手这两颗牌子的键（按确认打开卡片） */
    const val DEC_CHIP = "dec"
    const val ART_CHIP = "art"

    /** 电视上的语种牌子（日语、韩语并成「日韩」） */
    val LANG_ORDER = listOf("zh", "yue", "en", "jk", "other")
    val LANG_KEY = mapOf("zh" to "fZh", "yue" to "fYue", "en" to "fEn", "jk" to "fJk", "other" to "fOther")
    /** 电脑端的年代写法（和电脑端一样的顺序） */
    val ERA_ORDER = listOf("更早", "70s", "80s", "90s", "00s", "10s", "20s")
    const val EARLIER = "更早"

    /** 电脑端的语种 → 电视上的分组；没有标签返回 null */
    fun langGroup(lang: String): String? = when (lang.trim()) {
        "" -> null
        "国语", "國語", "普通话", "zh" -> "zh"
        "粤语", "粵語", "yue" -> "yue"
        "英文", "英语", "en" -> "en"
        "日语", "日語", "韩语", "韓語", "日韩", "ja", "ko", "jk" -> "jk"
        else -> "other"
    }

    /** 一颗牌子：[key] 是筛选值（年代 / 歌手是 dec / art），[drawer] 表示按确认打开卡片 */
    data class Chip(val key: String, val drawer: Boolean)

    /** 这颗牌子是不是「现在选着的那个」 */
    fun isSelected(c: Chip, filter: String) = c.key == filter || (c.drawer && filter.startsWith(c.key + ":"))

    /**
     * 筛选排上有哪几颗：全部 → 常点（有常点的歌才有）→ 曲库里有的语种 → 年代（有带年代的歌才有）→ 歌手（有歌手才有）
     */
    fun chips(songs: List<Song>, hasFav: Boolean): List<Chip> {
        val out = ArrayList<Chip>(9)
        out += Chip(ALL, false)
        if (hasFav) out += Chip(FAV, false)
        val langs = songs.mapNotNullTo(HashSet()) { langGroup(it.lang) }
        LANG_ORDER.filter { it in langs }.forEach { out += Chip(LANG + it, false) }
        if (songs.any { it.era.isNotBlank() }) out += Chip(DEC_CHIP, true)
        if (songs.any { !it.artist.isNullOrBlank() }) out += Chip(ART_CHIP, true)
        return out
    }

    /**
     * 用筛选过一遍（[list] 是已经按首字母搜过的）。常点按 [favRank]（编号 → 名次，0 最常点）排。
     */
    fun apply(list: List<Song>, filter: String, favRank: Map<String, Int>): List<Song> = when {
        filter == ALL -> list
        filter == FAV -> list.filter { it.id in favRank }.sortedBy { favRank[it.id] ?: Int.MAX_VALUE }
        filter.startsWith(LANG) -> filter.removePrefix(LANG).let { g -> list.filter { langGroup(it.lang) == g } }
        filter.startsWith(DEC) -> filter.removePrefix(DEC).let { e -> list.filter { it.era.trim() == e } }
        filter.startsWith(ART) -> filter.removePrefix(ART).let { a -> list.filter { it.artist?.trim() == a } }
        else -> list
    }

    /** 这个筛选在现在的曲库里还有没有意义（曲库同步以后，选着的歌手可能没了）；没有就回到「全部」 */
    fun isValid(songs: List<Song>, filter: String, hasFav: Boolean): Boolean = when {
        filter == ALL -> true
        filter == FAV -> hasFav
        filter.startsWith(LANG) || filter.startsWith(DEC) || filter.startsWith(ART) -> apply(songs, filter, emptyMap()).isNotEmpty()
        else -> false
    }

    /** 年代卡片里的格子：(年代, 几首)，只列有歌的，按 更早、70s … 20s 排（认不出的写法排在最后） */
    fun eraOptions(songs: List<Song>): List<Pair<String, Int>> {
        val n = LinkedHashMap<String, Int>()
        for (s in songs) { val e = s.era.trim(); if (e.isNotEmpty()) n[e] = (n[e] ?: 0) + 1 }
        return n.entries.sortedWith(compareBy({ ERA_ORDER.indexOf(it.key).let { i -> if (i < 0) ERA_ORDER.size else i } }, { it.key }))
            .map { it.key to it.value }
    }

    /**
     * 歌手卡片里的格子：(歌手, 几首)。歌多的排前面，一样多的按拼音。
     * 只列有 2 首以上的歌手；一个都没有就全列。
     */
    fun artistOptions(songs: List<Song>, collator: Comparator<Any?> = pinyin()): List<Pair<String, Int>> {
        val n = HashMap<String, Int>()
        for (s in songs) { val a = s.artist?.trim().orEmpty(); if (a.isNotEmpty()) n[a] = (n[a] ?: 0) + 1 }
        val all = n.entries.sortedWith { x, y -> if (x.value != y.value) y.value - x.value else collator.compare(x.key, y.key) }
            .map { it.key to it.value }
        val many = all.filter { it.second >= 2 }
        return if (many.isNotEmpty()) many else all
    }

    /** 中文按拼音排（安卓 5 的 Collator 对简体中文就是拼音序） */
    @Suppress("UNCHECKED_CAST")
    fun pinyin(): Comparator<Any?> = Collator.getInstance(Locale.SIMPLIFIED_CHINESE) as Comparator<Any?>

    /**
     * 筛选排放不下时，显示第几颗到第几颗（左闭右开）。
     * [w] 每颗的宽度，[room] 整排宽，[arrow] 一个小箭头占的宽（‹ 或 ›，含留白）。
     * 只显示整颗的牌子；[keep]（焦点那颗，或选中的那颗）一定在里面，在这个前提下起点取最小——
     * 但从上一次的起点 [prevStart] 出发，往左走回来时尽量多露出左边的。和设计稿 tv-pick.html 的 layoutStrip() 同一个算法。
     */
    fun layoutStrip(w: List<Float>, room: Float, arrow: Float, keep: Int, prevStart: Int): IntArray {
        val n = w.size
        if (n == 0) return intArrayOf(0, 0)
        val k = keep.coerceIn(0, n - 1)
        fun upto(s: Int, lim: Float): Int {
            var e = s; var used = 0f
            while (e < n && used + w[e] <= lim) { used += w[e]; e++ }
            return e
        }
        fun end(s: Int): Int {
            val r = room - (if (s > 0) arrow else 0f)
            val e = upto(s, r)
            return if (e == n) n else upto(s, r - arrow)
        }
        var s = prevStart.coerceIn(0, n - 1)
        if (k < s) s = k
        while (s > 0 && end(s - 1) > k) s--          // 能往左多露就多露
        while (s < k && end(s) <= k) s++              // 焦点那颗要在里面
        return intArrayOf(s, maxOf(end(s), s + 1))    // 一颗都放不下时（不会发生）也至少给一颗
    }
}
