package com.banzou.ktv

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.KeyEvent
import android.view.View
import kotlin.math.max
import kotlin.math.min

/** v9 新界面共用的一点小东西 */
object V9 {
    /** 筛选排、卡片里显示的字：语种牌子、年代（「更早」要翻译，80s 之类三种语言一样） */
    fun eraLabel(era: String) = if (era == Filters.EARLIER) L.t("fEarlier") else era

    fun chipLabel(c: Filters.Chip, filter: String): String = when {
        c.key == Filters.ALL -> L.t("fAll")
        c.key == Filters.FAV -> L.t("fFav")
        c.key.startsWith(Filters.LANG) -> L.t(Filters.LANG_KEY[c.key.removePrefix(Filters.LANG)] ?: "fOther")
        c.key == Filters.DEC_CHIP -> if (filter.startsWith(Filters.DEC)) eraLabel(filter.removePrefix(Filters.DEC)) else L.t("fDecade")
        c.key == Filters.ART_CHIP -> if (filter.startsWith(Filters.ART)) filter.removePrefix(Filters.ART) else L.t("fArtist")
        else -> c.key
    }

    /** 量着截短，结尾「...」（系统的省略号在衬线体里只画成一个点） */
    fun fit(t: String, p: Paint, room: Float): String {
        if (p.measureText(t) <= room) return t
        val dots = "..."
        var n = t.length
        while (n > 0 && p.measureText(t, 0, n) + p.measureText(dots) > room) n--
        return t.substring(0, n).trimEnd() + dots
    }

    /** 小标题（label 样式）：中文 24px 字距 .2；英文全大写 21px 字距 .26 */
    fun styleLabel(p: Paint) {
        val en = L.isEnglish
        p.textSize = (if (en) 21f else 24f) * Art.s
        p.letterSpacing = if (en) 0.26f else 0.2f
    }

    /** 「还有更多」那种 V 形小箭头（32×18，2px 靛蓝线） */
    fun drawMore(c: Canvas, x: Float, y: Float, p: Paint) {
        val s = Art.s
        c.drawLine(x + 3f * s, y + 3f * s, x + 16f * s, y + 14f * s, p)
        c.drawLine(x + 16f * s, y + 14f * s, x + 29f * s, y + 3f * s, p)
    }
}

/**
 * 筛选排（1200×56）：全部 / 常点 / 语种 / 年代 ˅ / 歌手 ˅。
 * 左右换一颗（到头就停），上、下、确认交给外面。放不下时只显示整颗的，两头画 ‹ ›（见 [Filters.layoutStrip]）。
 * 这个 View 比 56 高 6px，给焦点牌子下面的平影留地方。
 */
class FilterStrip(context: Context) : View(context) {
    var chips: List<Filters.Chip> = listOf(Filters.Chip(Filters.ALL, false))
    var filter = Filters.ALL
    /** 选中的那颗旁边的小数字（和首字母一起算以后的数） */
    var count = 0
    /** 焦点在第几颗 */
    var focusIdx = 0
    var onUp: () -> Unit = {}
    var onDown: () -> Unit = {}
    var onChoose: (Int) -> Unit = {}

    private val s = Art.s
    private var start = 0
    private val focus = FocusBlock(bead = false)
    private val text = Art.textPaint(26f, Art.INK, 0.1f)
    private val num = Art.textPaint(22f, Art.INDIGO, 0.04f)
    private val under = Paint().apply { color = Art.INDIGO }
    private val chev = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.8f * s; strokeJoin = Paint.Join.MITER }
    private val arrow = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Art.INDIGO }
    private val path = Path()
    private val box = Rect()

    init { isFocusable = true }

    fun selIdx() = chips.indexOfFirst { Filters.isSelected(it, filter) }.coerceAtLeast(0)

    fun update(chips: List<Filters.Chip>, filter: String, count: Int) {
        this.chips = chips; this.filter = filter; this.count = count
        focusIdx = focusIdx.coerceIn(0, max(0, chips.size - 1))
        invalidate()
    }

    private fun label(i: Int): String {
        val c = chips[i]
        val t = V9.chipLabel(c, filter)
        return if (c.drawer) V9.fit(t, text, 220f * s) else t   // 名字最宽 220，超出用省略号
    }

    private fun widthOf(i: Int, lab: String): Float {
        var w = 16f * s + text.measureText(lab) + 16f * s
        if (Filters.isSelected(chips[i], filter)) w += 10f * s + num.measureText(count.toString())
        if (chips[i].drawer) w += 10f * s + 14f * s
        return w
    }

    override fun onDraw(c: Canvas) {
        if (chips.isEmpty()) return
        text.letterSpacing = if (L.isEnglish) 0.03f else 0.1f
        val labels = chips.indices.map { label(it) }
        val widths = chips.indices.map { widthOf(it, labels[it]) }
        val keep = if (hasFocus()) focusIdx else selIdx()
        val se = Filters.layoutStrip(widths, 1200f * s, 28f * s, keep, start)
        start = se[0]
        val h = 56f * s
        val cy = h / 2
        var x = 0f
        if (se[0] > 0) {
            // ‹（18×32）+ 右边留 10
            val ay = cy - 16f * s
            path.reset(); path.moveTo(15f * s, ay + 3f * s); path.lineTo(4f * s, ay + 16f * s); path.lineTo(15f * s, ay + 29f * s)
            c.drawPath(path, arrow)
            x = 28f * s
        }
        for (i in se[0] until se[1]) {
            val w = widths[i]
            val focused = hasFocus() && i == focusIdx
            val sel = Filters.isSelected(chips[i], filter)
            if (focused) {
                box.set(x.toInt(), 0, (x + w).toInt(), h.toInt())
                focus.bounds = box
                focus.draw(c)
            } else if (sel) {
                c.drawRect(x + 16f * s, h - 7f * s - 3f * s, x + w - 16f * s, h - 7f * s, under)
            }
            text.color = if (focused) Art.FROST else Art.INK
            var tx = x + 16f * s
            c.drawText(labels[i], tx, cy - (text.ascent() + text.descent()) / 2, text)
            tx += text.measureText(labels[i])
            if (sel) {
                tx += 10f * s
                num.color = if (focused) Art.OAT else Art.INDIGO
                val n = count.toString()
                c.drawText(n, tx, cy - (text.ascent() + text.descent()) / 2, num)
                tx += num.measureText(n)
            }
            if (chips[i].drawer) {
                tx += 10f * s
                chev.color = text.color
                val top = cy - 4.5f * s
                path.reset(); path.moveTo(tx + 1.5f * s, top + 1.5f * s); path.lineTo(tx + 7f * s, top + 7f * s); path.lineTo(tx + 12.5f * s, top + 1.5f * s)
                c.drawPath(path, chev)
            }
            x += w
        }
        if (se[1] < chips.size) {
            // ›：左边留 10
            val ax = x + 10f * s; val ay = cy - 16f * s
            path.reset(); path.moveTo(ax + 3f * s, ay + 3f * s); path.lineTo(ax + 14f * s, ay + 16f * s); path.lineTo(ax + 3f * s, ay + 29f * s)
            c.drawPath(path, arrow)
        }
    }

    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        invalidate()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> focusIdx = max(0, focusIdx - 1)
            KeyEvent.KEYCODE_DPAD_RIGHT -> focusIdx = min(chips.size - 1, focusIdx + 1)
            KeyEvent.KEYCODE_DPAD_UP -> onUp()
            KeyEvent.KEYCODE_DPAD_DOWN -> onDown()
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> onChoose(focusIdx)
            else -> return super.onKeyDown(keyCode, event)
        }
        invalidate()
        return true
    }
}

/**
 * 年代 / 歌手的卡片：和语言卡片、二维码卡片同一种。4 列的格子，每格 270×72，最多 6 行，多了按行滚。
 * 方向键在格子里走（到边就停），确认 = 选这个；返回由外面关。
 */
class GridCard(context: Context) : View(context) {
    /** 一格：(值, 显示的字, 几首) */
    data class Opt(val value: String, val label: String, val count: Int)

    var onChoose: (String) -> Unit = {}
    var kind = ""
        private set
    private var title = ""
    private var opts: List<Opt> = emptyList()
    private var selected: String? = null
    private var sel = 0
    private var gStart = 0

    private val s = Art.s
    private val backdrop = Paint().apply { color = Color.argb(209, 232, 231, 228) }
    private val card = Paint().apply { color = Art.CARD }
    private val shadow = Paint().apply { color = Color.argb(36, 0, 0, 0) }
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Art.INK }
    private val titleP = Art.textPaint(24f, Art.GREY, 0.2f).apply { textAlign = Paint.Align.CENTER }
    private val name = Art.textPaint(32f, Art.INK, 0.04f)
    private val num = Art.textPaint(22f, Art.INDIGO, 0.04f)
    private val under = Paint().apply { color = Art.INDIGO }
    private val more = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Art.INDIGO }
    private val focus = FocusBlock(bead = false)
    private val box = Rect()

    init { isFocusable = true }

    fun open(kind: String, title: String, opts: List<Opt>, selected: String?) {
        this.kind = kind; this.title = title; this.opts = opts; this.selected = selected
        sel = opts.indexOfFirst { it.value == selected }.coerceAtLeast(0)
        gStart = 0
        scroll()
        invalidate()
    }

    private val rows get() = (opts.size + COLS - 1) / COLS

    /** 焦点走出去时整块挪一行 */
    private fun scroll() {
        val r = sel / COLS
        if (r < gStart) gStart = r
        if (r >= gStart + ROWS) gStart = r - ROWS + 1
        gStart = gStart.coerceIn(0, max(0, rows - ROWS))
    }

    override fun onDraw(c: Canvas) {
        c.drawRect(0f, 152f * s, width.toFloat(), (152f + 796f) * s, backdrop)
        val vis = max(1, min(rows, ROWS))
        val hh = 46f + 30f + 26f + vis * 72f + (vis - 1) * 8f + 56f + 4f
        val l = 340f * s; val w = 1240f * s
        val t = (550f - hh / 2) * s; val b = t + hh * s
        c.drawRect(l, t + 10f * s, l + w, b + 10f * s, shadow)
        c.drawRect(l, t, l + w, b, card)
        c.drawRect(l, t, l + w, b, border)

        V9.styleLabel(titleP)
        val head = if (L.isEnglish) title.uppercase() else title
        val ty = t + (2f + 46f) * s
        c.drawText(head, l + w / 2, ty + 15f * s - (titleP.ascent() + titleP.descent()) / 2, titleP)

        val gx = l + (2f + 56f) * s
        val gy = ty + (30f + 26f) * s
        val cw = 270f * s; val ch = 72f * s
        for (j in 0 until vis * COLS) {
            val i = gStart * COLS + j
            if (i >= opts.size) break
            val o = opts[i]
            val x = gx + (j % COLS) * (cw + 16f * s)
            val y = gy + (j / COLS) * (ch + 8f * s)
            val focused = i == sel
            if (focused) {
                box.set(x.toInt(), y.toInt(), (x + cw).toInt(), (y + ch).toInt())
                focus.bounds = box
                focus.draw(c)
            } else if (o.value == selected) {
                c.drawRect(x + 22f * s, y + ch - 9f * s - 3f * s, x + cw - 22f * s, y + ch - 9f * s, under)
            }
            val n = o.count.toString()
            val nw = num.measureText(n)
            val lab = V9.fit(o.label, name, cw - 44f * s - 12f * s - nw)
            name.color = if (focused) Art.FROST else Art.INK
            num.color = if (focused) Art.OAT else Art.INDIGO
            val base = y + ch / 2 - (name.ascent() + name.descent()) / 2
            c.drawText(lab, x + 22f * s, base, name)
            c.drawText(n, x + 22f * s + name.measureText(lab) + 12f * s, base, num)
        }
        // 下面还有：卡片底边里面居中一个「还有更多」小箭头
        if (gStart + ROWS < rows) V9.drawMore(c, l + w / 2 - 16f * s, b - 20f * s - 18f * s, more)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val n = opts.size
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> if (sel % COLS > 0) sel--
            KeyEvent.KEYCODE_DPAD_RIGHT -> if (sel % COLS < COLS - 1 && sel < n - 1) sel++
            KeyEvent.KEYCODE_DPAD_UP -> if (sel >= COLS) sel -= COLS
            KeyEvent.KEYCODE_DPAD_DOWN -> if (sel + COLS < n) sel += COLS else if (sel / COLS < (n - 1) / COLS) sel = n - 1
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> {
                opts.getOrNull(sel)?.let { onChoose(it.value) }
                return true
            }
            else -> return super.onKeyDown(keyCode, event)
        }
        scroll()
        invalidate()
        return true
    }

    companion object {
        const val COLS = 4
        const val ROWS = 6
    }
}

/** 试听下面那一行右头的小字：「国语 · 00s」（23px 暖灰，中间一颗 5px 灰圆点，两边各留 12） */
class TagLine(context: Context) : View(context) {
    private val s = Art.s
    private val p = Art.textPaint(23f, Art.GREY, 0.12f)
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Art.GREY }
    private var a = ""
    private var b = ""

    fun set(a: String, b: String) {
        if (a == this.a && b == this.b) return
        this.a = a; this.b = b
        invalidate()
    }

    override fun onDraw(c: Canvas) {
        if (a.isEmpty() && b.isEmpty()) return
        p.letterSpacing = if (L.isEnglish) 0.04f else 0.12f
        val base = height / 2f - (p.ascent() + p.descent()) / 2
        var x = width.toFloat()
        if (b.isNotEmpty()) { x -= p.measureText(b); c.drawText(b, x, base, p) }
        if (a.isNotEmpty() && b.isNotEmpty()) { x -= 12f * s + 2.5f * s; c.drawCircle(x, height / 2f, 2.5f * s, dot); x -= 2.5f * s + 12f * s }
        if (a.isNotEmpty()) { x -= p.measureText(a); c.drawText(a, x, base, p) }
    }
}

/** 歌单页中间一栏空着的时候：一圈珠子的徽记（72px，顶在 y 402）+ 下面 28px 一行 32px 暖灰的字（放不下就折行，居中） */
class ListEmptyView(context: Context) : View(context) {
    var text = ""
        set(v) { if (v != field) { field = v; layout = null; invalidate() } }

    private val s = Art.s
    private val emblem = Emblem()
    private val p = TextPaint(Art.textPaint(32f, Art.GREY, 0.04f))
    private var layout: StaticLayout? = null

    override fun onDraw(c: Canvas) {
        // 这个 View 从 y 252 开始，所以徽记在 150
        val top = 150f * s
        emblem.draw(c, (width - 72f * s) / 2, top, 72f * s, Art.MID, 2.2f, Art.INDIGO)
        val w = (width - 36f * s).toInt()
        @Suppress("DEPRECATION")
        val l = layout ?: StaticLayout(text, p, w, Layout.Alignment.ALIGN_CENTER, 1.5f, 0f, false).also { layout = it }
        c.save(); c.translate(18f * s, top + 72f * s + 28f * s); l.draw(c); c.restore()
    }
}

/**
 * 歌曲行、歌单行最左边那颗小圆点（焦点圆珠的位置，行左边 28px 处）。
 * 常点的歌：9px 靛蓝；歌单页里正在看的那张歌单：15px 靛蓝。焦点到这一行（activated）时不画，换成焦点牌子自己的燕麦色圆珠。
 */
class RowDot : Drawable() {
    var on = false
        set(v) { if (v != field) { field = v; invalidateSelf() } }
    var radius = 4.5f
    private val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Art.INDIGO }
    private var activated = false

    override fun isStateful() = true
    override fun onStateChange(state: IntArray): Boolean {
        val a = state.contains(android.R.attr.state_activated)
        if (a == activated) return false
        activated = a
        invalidateSelf()
        return true
    }

    override fun draw(c: Canvas) {
        if (!on || activated) return
        c.drawCircle(bounds.left + 28f * Art.s, bounds.exactCenterY(), radius * Art.s, p)
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/** 「我的歌单」牌子左边的小记号（28×28）：三颗小圆点 + 三道横线 */
class ListIcon : Drawable() {
    var color = Art.INK
        set(v) { field = v; invalidateSelf() }
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.8f * Art.s }
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)

    override fun getIntrinsicWidth() = Art.pxi(28f)
    override fun getIntrinsicHeight() = Art.pxi(28f)

    override fun draw(c: Canvas) {
        val s = Art.s
        val x = bounds.left.toFloat(); val y = bounds.top.toFloat()
        line.color = color; dot.color = color
        for (r in floatArrayOf(7f, 14f, 21f)) {
            c.drawLine(x + 10f * s, y + r * s, x + 25f * s, y + r * s, line)
            c.drawCircle(x + 4f * s, y + r * s, 1.9f * s, dot)
        }
    }

    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/** 顶栏牌子下面「现在在这一页」的 3px 靛蓝线（左右缩 22、离底 8） */
class ChipUnder : Drawable() {
    private val p = Paint().apply { color = Art.INDIGO }
    override fun draw(c: Canvas) {
        val b = bounds; val s = Art.s
        c.drawRect(b.left + 22f * s, b.bottom - 8f * s - 3f * s, b.right - 22f * s, b.bottom - 8f * s, p)
    }
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/** 徽记当 Drawable 用（试听框空着的时候放在灰底中间） */
class EmblemDrawable(private val size: Float) : Drawable() {
    private val e = Emblem()
    override fun getIntrinsicWidth() = Art.pxi(size)
    override fun getIntrinsicHeight() = Art.pxi(size)
    override fun draw(c: Canvas) = e.draw(c, bounds.left.toFloat(), bounds.top.toFloat(), size * Art.s, Art.MID, 2.2f, Art.INDIGO)
    override fun setAlpha(alpha: Int) {}
    override fun setColorFilter(cf: ColorFilter?) {}
    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}
