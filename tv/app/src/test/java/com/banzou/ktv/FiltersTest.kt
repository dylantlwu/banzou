package com.banzou.ktv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FiltersTest {
    private fun song(id: String, artist: String? = null, lang: String = "", era: String = "") =
        Song(id, "t$id", artist, id.uppercase(), null, null, false, false, false, null, lang, era)

    private val lib = listOf(
        song("a", "周杰伦", "国语", "00s"), song("b", "周杰伦", "国语", "00s"), song("c", "陈奕迅", "粤语", "00s"),
        song("d", "Beyond", "粤语", "90s"), song("e", "Beyond", "粤语", "80s"), song("f", "米津玄師", "日语", "10s"),
        song("g", "IU", "韩语", "10s"), song("h", null, "英文", "更早"),
    )

    @Test fun oldCatalogHasOnlyAll() {
        val old = listOf(song("x"), song("y"))
        assertEquals(listOf(Filters.Chip(Filters.ALL, false)), Filters.chips(old, hasFav = false))
        assertEquals(old, Filters.apply(old, Filters.ALL, emptyMap()))
        assertTrue(Filters.eraOptions(old).isEmpty())
        assertTrue(Filters.artistOptions(old).isEmpty())
        assertFalse(Filters.isValid(old, "lang:zh", false))
    }

    @Test fun chipsOrderAndJk() {
        val keys = Filters.chips(lib, hasFav = true).map { it.key }
        assertEquals(listOf("all", "fav", "lang:zh", "lang:yue", "lang:en", "lang:jk", "dec", "art"), keys)
        assertEquals(listOf("f", "g"), Filters.apply(lib, "lang:jk", emptyMap()).map { it.id })
    }

    @Test fun applyFilters() {
        assertEquals(listOf("d"), Filters.apply(lib, "dec:90s", emptyMap()).map { it.id })
        assertEquals(listOf("d", "e"), Filters.apply(lib, "art:Beyond", emptyMap()).map { it.id })
        assertEquals(listOf("c", "a"), Filters.apply(lib, Filters.FAV, mapOf("c" to 0, "a" to 1)).map { it.id })
    }

    @Test fun eraOrder() {
        assertEquals(listOf("更早" to 1, "80s" to 1, "90s" to 1, "00s" to 3, "10s" to 2), Filters.eraOptions(lib))
    }

    @Test fun artistsTwoOrMore() {
        val byName = Comparator<Any?> { x, y -> (x as String).compareTo(y as String) }
        assertEquals(listOf("Beyond" to 2, "周杰伦" to 2), Filters.artistOptions(lib, byName))
        val one = listOf(song("x", "B"), song("y", "A"))
        assertEquals(listOf("A" to 1, "B" to 1), Filters.artistOptions(one, byName))   // 一个都不剩就全列
    }

    @Test fun stripFitsAll() {
        val w = List(9) { 100f }
        assertEquals(listOf(0, 9), Filters.layoutStrip(w, 1200f, 28f, 8, 0).toList())
    }

    @Test fun stripScrolls() {
        val w = List(12) { 150f }   // 1800 > 1200
        val a = Filters.layoutStrip(w, 1200f, 28f, 0, 0)
        assertEquals(0, a[0]); assertTrue(a[1] < 12)
        assertTrue(w.subList(a[0], a[1]).sum() + 28f <= 1200f)
        val b = Filters.layoutStrip(w, 1200f, 28f, 11, a[0])   // 走到最右：它刚好是最后一颗
        assertEquals(12, b[1]); assertTrue(b[0] > 0)
        assertTrue(w.subList(b[0], b[1]).sum() + 28f <= 1200f)
        val c = Filters.layoutStrip(w, 1200f, 28f, 5, b[0])    // 往左走回来：起点不超过 5，并尽量多露左边
        assertTrue(c[0] <= 5 && c[1] > 5)
        val d = Filters.layoutStrip(listOf(2000f, 10f), 1200f, 28f, 0, 0)   // 一颗比整排还宽：不死循环
        assertEquals(0, d[0]); assertEquals(1, d[1])
    }
}
