package com.banzou.ktv

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.KeyEvent
import android.view.View
import kotlin.math.max
import kotlin.math.roundToInt

/** 按键提示里的小方框（确认、返回、菜单，或一个箭头） */
class CapPainter(lineColor: Int, textColor: Int, private val fillColor: Int) {
    private val s = Art.s
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f * s; color = lineColor; strokeCap = Paint.Cap.ROUND }
    private val fill = Paint().apply { color = fillColor }
    private val text = Art.textPaint(23f, textColor, 0.06f).apply { textAlign = Paint.Align.CENTER }
    val height = 42f * s

    fun width(label: String) = max(46f * s, text.measureText(label) + 26f * s)

    /** 画一个带字的框，返回宽度 */
    fun draw(c: Canvas, label: String, x: Float, cy: Float): Float {
        val w = width(label)
        box(c, x, cy, w)
        c.drawText(label, x + w / 2, cy - (text.ascent() + text.descent()) / 2, text)
        return w
    }

    /** 画一个带箭头的框（0 上 1 右 2 下 3 左），返回宽度 */
    fun arrow(c: Canvas, dir: Int, x: Float, cy: Float): Float {
        val w = 46f * s
        box(c, x, cy, w)
        val cx = x + w / 2
        val a = 9f * s
        c.save()
        c.rotate(dir * 90f, cx, cy)
        c.drawLine(cx, cy + a, cx, cy - a, line)
        c.drawLine(cx, cy - a, cx - a * 0.6f, cy - a * 0.35f, line)
        c.drawLine(cx, cy - a, cx + a * 0.6f, cy - a * 0.35f, line)
        c.restore()
        return w
    }

    private fun box(c: Canvas, x: Float, cy: Float, w: Float) {
        if (Color.alpha(fillColor) > 0) c.drawRect(x, cy - height / 2, x + w, cy + height / 2, fill)
        c.drawRect(x, cy - height / 2, x + w, cy + height / 2, line)
    }
}

/** 标志：徽记 + 「波点」+ 一行很小的 BODIAN */
class LockupView(context: Context) : View(context) {
    private val s = Art.s
    private val emblem = Emblem()
    private val brand = Art.textPaint(33f, Art.INK, 0.42f)
    private val latin = Art.textPaint(11f, Art.INK, 0.62f).apply { alpha = 158 }
    private var name = ""
    private var sub = ""

    fun refresh() {
        name = L.t("brand"); sub = L.t("brandLatin")
        requestLayout(); invalidate()
    }

    override fun onMeasure(wSpec: Int, hSpec: Int) {
        val w = 66f * s + 17f * s + max(brand.measureText(name), latin.measureText(sub))
        setMeasuredDimension(w.roundToInt() + 2, (80f * s).roundToInt())
    }

    override fun onDraw(c: Canvas) {
        val top = (height - 66f * s) / 2
        emblem.draw(c, 0f, top, 66f * s, Art.INK, 2.4f, Art.INDIGO)
        val x = 83f * s
        c.drawText(name, x, top + 40f * s, brand)
        c.drawText(sub, x, top + 60f * s, latin)
    }
}

/** 屏幕下方的一行按键提示：只写当前这一栏能做什么 */
class HintsView(context: Context) : View(context) {
    private val s = Art.s
    private val caps = CapPainter(Art.HINT_LINE, Art.HINT, Color.TRANSPARENT)
    private val label = Art.textPaint(27f, Art.HINT, 0.04f)
    private var keys: List<String> = emptyList()
    private var texts: List<String> = emptyList()

    fun set(items: List<Pair<String, String>>) {
        keys = items.map { it.first }; texts = items.map { it.second }
        invalidate()
    }

    override fun onDraw(c: Canvas) {
        var x = 0f
        val cy = height / 2f
        val base = cy - (label.ascent() + label.descent()) / 2
        for (i in keys.indices) {
            x += caps.draw(c, keys[i], x, cy) + 14f * s
            c.drawText(texts[i], x, base, label)
            x += label.measureText(texts[i]) + 48f * s
        }
    }
}

/**
 * 字母键盘：A–Z 一格一格的细线方格，最后一行是 Y、Z、删（两格）、清空（两格）。
 * 自己处理方向键：到了最上面一行再按上、到了最右边再按右，交给外面换地方。
 */
class KeypadView(context: Context) : View(context) {
    var onKey: (String) -> Unit = {}
    var onExitUp: () -> Unit = {}
    var onExitRight: () -> Unit = {}

    private val s = Art.s
    private val cell = 70f * s
    private val gap = 12f * s
    private var sel = 9
    private val grid = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 1.5f * s; color = Art.KEYLINE }
    private val block = Paint().apply { color = Art.INK }
    private val shadow = Paint().apply { color = Color.argb(26, 40, 40, 42) }
    private val keyline = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Art.OAT; alpha = 230 }
    private val letter = Art.textPaint(33f, Art.INK).apply { textAlign = Paint.Align.CENTER }
    private val word = Art.textPaint(27f, Art.INK, 0.12f).apply { textAlign = Paint.Align.CENTER }
    private val r = RectF()
    private var del = ""
    private var clear = ""

    init { isFocusable = true; refresh() }

    /** 换语言以后重新取「删」「清空」的字 */
    fun refresh() {
        del = if (L.isEnglish) L.t("keyDel").uppercase() else L.t("keyDel")
        clear = if (L.isEnglish) L.t("keyClear").uppercase() else L.t("keyClear")
        word.textSize = (if (L.isEnglish) 22f else 27f) * s
        word.letterSpacing = if (L.isEnglish) 0.16f else 0.12f
        invalidate()
    }

    override fun onMeasure(wSpec: Int, hSpec: Int) {
        // 四周多留一圈 [PAD]，放大的焦点键才不会被裁掉
        setMeasuredDimension((6 * cell + 5 * gap + 2 * PAD * s).roundToInt(), (5 * cell + 4 * gap + 2 * PAD * s).roundToInt())
    }

    private fun rectOf(i: Int) {
        val row = if (i < 24) i / 6 else 4
        val col = when { i < 24 -> i % 6; i == 24 -> 0; i == 25 -> 1; i == 26 -> 2; else -> 4 }
        val w = if (i >= 26) 2 * cell + gap else cell
        val x = col * (cell + gap); val y = row * (cell + gap)
        r.set(x, y, x + w, y + cell)
    }

    private fun label(i: Int) = when (i) { 26 -> del; 27 -> clear; else -> LETTERS[i] }

    override fun onDraw(c: Canvas) {
        val focused = hasFocus()
        c.translate(PAD * s, PAD * s)
        for (i in 0 until COUNT) {
            if (focused && i == sel) continue
            rectOf(i)
            c.drawRect(r, grid)
            val p = if (i >= 26) word else letter
            p.color = Art.INK
            c.drawText(label(i), r.centerX(), r.centerY() - (p.ascent() + p.descent()) / 2, p)
        }
        if (focused) {
            rectOf(sel)
            val k = if (sel >= 26) 1.08f else 1.16f
            c.save()
            c.scale(k, k, r.centerX(), r.centerY())
            c.drawRect(r.left, r.top + 5f * s, r.right, r.bottom + 5f * s, shadow)
            c.drawRect(r, block)
            c.drawRect(r.left + 6f * s, r.top + 6f * s, r.right - 6f * s, r.bottom - 6f * s, keyline)
            val p = if (sel >= 26) word else letter
            p.color = Art.FROST
            c.drawText(label(sel), r.centerX(), r.centerY() - (p.ascent() + p.descent()) / 2, p)
            c.restore()
        }
    }

    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        invalidate()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_LEFT -> if (sel > 24 || (sel < 24 && sel % 6 > 0)) sel--
            KeyEvent.KEYCODE_DPAD_RIGHT -> if (if (sel < 24) sel % 6 < 5 else sel < 27) sel++ else onExitRight()
            KeyEvent.KEYCODE_DPAD_UP -> when {
                sel >= 24 -> sel = UP_FROM_LAST[sel - 24]
                sel >= 6 -> sel -= 6
                else -> onExitUp()
            }
            KeyEvent.KEYCODE_DPAD_DOWN -> if (sel < 18) sel += 6 else if (sel < 24) sel = 24 + DOWN_TO_LAST[sel % 6]
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER ->
                onKey(when (sel) { 26 -> DEL; 27 -> CLEAR; else -> LETTERS[sel] })
            else -> return super.onKeyDown(keyCode, event)
        }
        invalidate()
        return true
    }

    companion object {
        const val DEL = "DEL"
        const val CLEAR = "CLEAR"
        const val COUNT = 28
        /** 四周留的边（设计稿像素）；摆位置时要往左上各挪这么多 */
        const val PAD = 10f
        val LETTERS = Array(26) { ('A' + it).toString() }
        private val UP_FROM_LAST = intArrayOf(18, 19, 20, 22)
        private val DOWN_TO_LAST = intArrayOf(0, 1, 2, 2, 3, 3)
    }
}

/**
 * 消息条：炭黑的牌子 + 木色细线 + 徽记。三种内容：一两行字、原唱 / 伴唱、音量。
 * 这个 View 横向占满，牌子画在中间。
 */
class ToastView(context: Context) : View(context) {
    private val s = Art.s
    private val emblem = Emblem()
    private val slab = Paint().apply { color = Art.INK }
    private val shadow = Paint().apply { color = Color.argb(41, 0, 0, 0) }
    private val keyline = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s }
    private val mainP = Art.textPaint(38f, Art.FROST, 0.03f)
    private val subP = Art.textPaint(27f, Art.SOFT, 0.02f)
    private val segP = Art.textPaint(42f, Art.FROST)
    private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Color.parseColor("#8A8C8F") }
    private val under = Paint().apply { color = Art.OAT }
    private val errLine = Color.parseColor("#B98478")

    private var kind = TEXT
    private var main = ""
    private var sub: String? = null
    private var err = false
    private var a = ""
    private var b = ""
    private var second = false
    private var level = 0
    private var contentW = 0f
    private var contentH = 0f

    fun text(main: String, sub: String?, err: Boolean) {
        // 牌子最宽 1600：太长的话（比如电脑传回来的出错原因）截短，免得冲出屏幕
        val room = 1600f * s - 256f * s
        kind = TEXT; this.main = fit(main, mainP, room); this.sub = sub?.takeIf { it.isNotEmpty() }?.let { fit(it, subP, room) }; this.err = err
        contentW = max(mainP.measureText(this.main), this.sub?.let { subP.measureText(it) } ?: 0f)
        contentH = (if (this.sub != null) 92f else 48f) * s
        invalidate()
    }

    /** 两个词并排，亮着的那个下面一道线（原唱 / 伴唱） */
    fun seg(first: String, second: String, secondOn: Boolean) {
        kind = SEG; a = first; b = second; this.second = secondOn; err = false
        contentW = segP.measureText(a) + 44f * s + segP.measureText(b)
        contentH = 62f * s
        invalidate()
    }

    /** 音量：名字 + 十颗圆点 + 数字 */
    fun volume(label: String, v: Float) {
        kind = VOL; main = label; level = (v * 100).roundToInt().coerceIn(0, 100); sub = level.toString(); err = false
        contentW = mainP.measureText(main) + 32f * s + 10 * 18f * s + 9 * 14f * s + 16f * s + 56f * s
        contentH = 48f * s
        invalidate()
    }

    private fun fit(t: String, p: Paint, room: Float): String {
        if (p.measureText(t) <= room) return t
        val dots = "..."
        var n = t.length
        while (n > 0 && p.measureText(t, 0, n) + p.measureText(dots) > room) n--
        return t.substring(0, n).trimEnd() + dots
    }

    override fun onDraw(c: Canvas) {
        val w = 40f * s + 60f * s + 30f * s + contentW + 56f * s
        val h = max(contentH, 60f * s) + 52f * s
        val x = (width - w) / 2
        c.drawRect(x, 8f * s, x + w, h + 8f * s, shadow)
        c.drawRect(x, 0f, x + w, h, slab)
        keyline.color = if (err) errLine else Art.OAT
        keyline.alpha = 204
        c.drawRect(x + 7f * s, 7f * s, x + w - 7f * s, h - 7f * s, keyline)
        emblem.draw(c, x + 40f * s, (h - 60f * s) / 2, 60f * s, if (err) Art.CLAY else Art.SILVER, 2.4f, if (err) Art.CLAY else Art.OAT)
        val tx = x + 130f * s
        val cy = h / 2
        when (kind) {
            TEXT -> {
                val sb = sub
                if (sb == null) c.drawText(main, tx, cy - (mainP.ascent() + mainP.descent()) / 2, mainP)
                else {
                    c.drawText(main, tx, cy - 8f * s, mainP)
                    c.drawText(sb, tx, cy + 34f * s, subP)
                }
            }
            SEG -> {
                val base = cy - (segP.ascent() + segP.descent()) / 2
                val wa = segP.measureText(a); val wb = segP.measureText(b)
                segP.color = if (second) ring.color else Art.FROST
                c.drawText(a, tx, base, segP)
                segP.color = if (second) Art.FROST else ring.color
                c.drawText(b, tx + wa + 44f * s, base, segP)
                val ux = if (second) tx + wa + 44f * s else tx
                c.drawRect(ux, base + 12f * s, ux + (if (second) wb else wa), base + 15f * s, under)
            }
            else -> {
                c.drawText(main, tx, cy - (mainP.ascent() + mainP.descent()) / 2, mainP)
                var dx = tx + mainP.measureText(main) + 32f * s + 9f * s
                val on = (level + 5) / 10
                for (i in 0 until 10) {
                    if (i < on) { dot.color = Art.OAT; c.drawCircle(dx, cy, 9f * s, dot) } else c.drawCircle(dx, cy, 8f * s, ring)
                    dx += 32f * s
                }
                val num = sub ?: ""
                c.drawText(num, x + w - 56f * s - mainP.measureText(num), cy - (mainP.ascent() + mainP.descent()) / 2, mainP)
            }
        }
    }

    companion object {
        private const val TEXT = 0
        private const val SEG = 1
        private const val VOL = 2
    }
}

/** 暂停卡片：中间一个「继续」，上下左右四个方向各写一件事，最下面「返回 去点歌」 */
class PauseCard(context: Context) : View(context) {
    private val s = Art.s
    private val card = Paint().apply { color = Art.CARD }
    private val shadow = Paint().apply { color = Color.argb(36, 0, 0, 0) }
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Art.INK }
    private val rule = Paint().apply { color = Art.LINE }
    private val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Art.INK }
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Art.OAT; alpha = 230 }
    private val title = Art.textPaint(64f, Art.INK, 0.3f).apply { textAlign = Paint.Align.CENTER }
    private val label = Art.textPaint(32f, Art.INK)
    private val center = Art.textPaint(36f, Art.FROST).apply { textAlign = Paint.Align.CENTER }
    private val hint = Art.textPaint(27f, Art.GREY, 0.04f)
    private val caps = CapPainter(Art.HINT_LINE, Art.HINT, Color.TRANSPARENT)

    override fun onDraw(c: Canvas) {
        val cx = width / 2f
        val w = 890f * s; val h = 672f * s
        val left = cx - w / 2; val top = 500f * s - h / 2
        c.drawRect(left, top + 10f * s, left + w, top + h + 10f * s, shadow)
        c.drawRect(left, top, left + w, top + h, card)
        c.drawRect(left, top, left + w, top + h, border)

        title.letterSpacing = if (L.isEnglish) 0.12f else 0.3f
        c.drawText(L.t("paused"), cx, top + 56f * s + 62f * s, title)

        val gridTop = top + 56f * s + 80f * s + 26f * s
        val midY = gridTop + 180f * s
        val base = -(label.ascent() + label.descent()) / 2
        // 上：原唱 / 伴唱
        row(c, 0, L.t("padVocal"), cx, gridTop + 50f * s, base)
        // 下：歌词开 / 关
        row(c, 2, L.t("padLyrics"), cx, gridTop + 310f * s, base)
        // 左：重唱
        val lt = L.t("restart")
        val lx = cx - 105f * s - 46f * s
        caps.arrow(c, 3, lx, midY)
        c.drawText(lt, lx - 16f * s - label.measureText(lt), midY + base, label)
        // 右：切歌
        val rx = cx + 105f * s
        caps.arrow(c, 1, rx, midY)
        c.drawText(L.t("skip"), rx + 46f * s + 16f * s, midY + base, label)
        // 中间：继续
        c.drawCircle(cx, midY, 75f * s, disc)
        c.drawCircle(cx, midY, 68f * s, ring)
        center.textSize = (if (L.isEnglish) 30f else 36f) * s
        c.drawText(L.t("resume"), cx, midY - (center.ascent() + center.descent()) / 2, center)

        val lineY = gridTop + 360f * s + 26f * s
        c.drawRect(left + 80f * s, lineY, left + w - 80f * s, lineY + 1.5f * s, rule)
        val back = L.t("kBack"); val go = L.t("goPick")
        val total = caps.width(back) + 14f * s + hint.measureText(go)
        val by = lineY + 26f * s + 21f * s
        val bx = cx - total / 2
        val cw = caps.draw(c, back, bx, by)
        c.drawText(go, bx + cw + 14f * s, by - (hint.ascent() + hint.descent()) / 2, hint)
    }

    private fun row(c: Canvas, dir: Int, text: String, cx: Float, cy: Float, base: Float) {
        val total = 46f * s + 16f * s + label.measureText(text)
        val x = cx - total / 2
        caps.arrow(c, dir, x, cy)
        c.drawText(text, x + 62f * s, cy + base, label)
    }
}

/** 语言卡片：跟随系统 / 简体中文 / 繁體中文 / English。上下选，确认选中 */
class LangCard(context: Context) : View(context) {
    var onChoose: (String) -> Unit = {}

    private val s = Art.s
    private var sel = 0
    private val card = Paint().apply { color = Art.CARD }
    private val shadow = Paint().apply { color = Color.argb(36, 0, 0, 0) }
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Art.INK }
    private val rule = Paint().apply { color = Art.LINE }
    private val block = Paint().apply { color = Art.INK }
    private val keyline = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Art.OAT; alpha = 230 }
    private val bead = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Art.OAT }
    private val check = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2.4f * s; strokeCap = Paint.Cap.ROUND }
    private val title = Art.textPaint(24f, Art.GREY, 0.2f).apply { textAlign = Paint.Align.CENTER }
    private val row = Art.textPaint(38f, Art.INK, 0.04f)

    init { isFocusable = true }

    fun open() { sel = L.MODES.indexOf(L.mode).coerceAtLeast(0); invalidate() }

    override fun onDraw(c: Canvas) {
        val cx = width / 2f
        val w = 660f * s; val rh = 88f * s
        val h = 56f * s + 54f * s + 4 * rh + 60f * s
        val left = cx - w / 2; val top = 540f * s - h / 2
        c.drawRect(left, top + 10f * s, left + w, top + h + 10f * s, shadow)
        c.drawRect(left, top, left + w, top + h, card)
        c.drawRect(left, top, left + w, top + h, border)
        val en = L.isEnglish
        title.textSize = (if (en) 21f else 24f) * s
        title.letterSpacing = if (en) 0.26f else 0.2f
        c.drawText(if (en) L.t("language").uppercase() else L.t("language"), cx, top + 56f * s + 22f * s, title)

        val x0 = left + 64f * s; val x1 = left + w - 64f * s
        val y0 = top + 110f * s
        for (i in 0 until 4) {
            val y = y0 + i * rh
            val focused = i == sel
            if (focused) {
                c.drawRect(x0 - 10f * s, y + 5f * s, x1 + 10f * s, y + rh + 5f * s, shadow)
                c.drawRect(x0 - 10f * s, y, x1 + 10f * s, y + rh, block)
                c.drawRect(x0 - 4f * s, y + 6f * s, x1 + 4f * s, y + rh - 6f * s, keyline)
                c.drawCircle(x0 + 30f * s, y + rh / 2, 7.5f * s, bead)
            } else if (i < 3 && i + 1 != sel) c.drawRect(x0, y + rh - 1f, x1, y + rh, rule)
            val mode = L.MODES[i]
            row.color = if (focused) Art.FROST else Art.INK
            c.drawText(if (mode == L.AUTO) L.t("followSystem") else L.NAMES[mode] ?: mode, x0 + 65f * s, y + rh / 2 - (row.ascent() + row.descent()) / 2, row)
            if (mode == L.mode) {
                check.color = if (focused) Art.OAT else Art.INDIGO
                val kx = x1 - 62f * s; val ky = y + rh / 2 - 18f * s
                c.drawLine(kx + 7f * s, ky + 19f * s, kx + 15f * s, ky + 27f * s, check)
                c.drawLine(kx + 15f * s, ky + 27f * s, kx + 30f * s, ky + 9f * s, check)
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_DPAD_UP -> sel = (sel - 1).coerceAtLeast(0)
            KeyEvent.KEYCODE_DPAD_DOWN -> sel = (sel + 1).coerceAtMost(3)
            KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {}
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> onChoose(L.MODES[sel])
            else -> return super.onKeyDown(keyCode, event)
        }
        invalidate()
        return true
    }
}

/** 还没有歌：左边一张带木框的图版（一圈珠子和它的倒影），右边一句话和手机网址 */
class EmptyView(context: Context) : View(context) {
    var address = ""
        set(v) { field = v; invalidate() }

    private val s = Art.s
    private val emblem = Emblem()
    private val plate = Paint().apply { color = Art.PLATE }
    private val mat = Paint().apply { color = Art.CARD }
    private val frame = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 4f * s; color = Art.INDIGO }
    private val oak = Paint().apply { color = Art.INDIGO }
    private val under = Paint().apply { color = Art.INK }
    private val small = Art.textPaint(24f, Art.GREY, 0.2f)
    private val head = Art.textPaint(84f, Art.INK, 0.2f)
    private val body = Art.textPaint(34f, Art.GREY, 0.06f)
    private val strong = Art.textPaint(34f, Art.INK, 0.06f)
    private val hint = Art.textPaint(25f, Art.GREY, 0.08f)
    private val addr = Art.textPaint(29f, Art.INK, 0.04f)
    private val lineColor = Color.parseColor("#5F6164")

    override fun onDraw(c: Canvas) {
        val en = L.isEnglish
        // 图版
        val pl = 316f * s; val pt = 236f * s; val pw = 468f * s; val ph = 620f * s
        // v8：外面 4px 靛蓝，里面 12px 卡片色留白，再里面是图版
        c.drawRect(pl - 16f * s, pt - 16f * s, pl + pw + 16f * s, pt + ph + 16f * s, mat)
        c.drawRect(pl - 14f * s, pt - 14f * s, pl + pw + 14f * s, pt + ph + 14f * s, frame)
        c.drawRect(pl, pt, pl + pw, pt + ph, plate)
        emblem.draw(c, pl + 74f * s, pt + 100f * s, 320f * s, lineColor, 1f, Art.INDIGO, glass = true)
        c.save()
        c.translate(pl + 74f * s, pt + 606f * s)
        c.scale(1f, -0.55f)
        emblem.draw(c, 0f, 0f, 320f * s, lineColor, 1f, Art.INDIGO, glass = false, alpha = 56)
        c.restore()

        // 右边的字
        val x = 940f * s
        var y = 330f * s + 24f * s
        small.textSize = (if (en) 21f else 24f) * s
        small.letterSpacing = if (en) 0.26f else 0.2f
        c.drawText(L.t("brandLatin"), x, y, small)
        y += 26f * s + 84f * s
        head.letterSpacing = if (en) 0.04f else 0.2f
        c.drawText(L.t("noSongs"), x, y, head)
        y += 40f * s + 58f * s
        body.letterSpacing = if (en) 0.02f else 0.06f
        strong.letterSpacing = body.letterSpacing
        // 一句话，里面两个名字（电脑上的程序名、按钮名）用深色加下划线
        val tpl = L.t("emptyHow")
        val limit = x + 884f * s
        var tx = x
        var i = 0
        while (i < tpl.length) {
            val open = tpl.indexOf('{', i)
            val end = if (open < 0) tpl.length else open
            if (end > i) {
                val w = body.measureText(tpl, i, end)
                if (tx + w > limit && tx > x) { tx = x; y += 58f * s }
                c.drawText(tpl, i, end, tx, y, body)
                tx += w
            }
            if (open < 0) break
            val close = tpl.indexOf('}', open)
            if (close < 0) break
            val word = if (tpl.regionMatches(open + 1, "app", 0, 3)) L.t("appName") else L.t("tvBtn")
            val w = strong.measureText(word)
            if (tx + w + 24f * s > limit && tx > x) { tx = x; y += 58f * s }
            tx += 12f * s
            c.drawText(word, tx, y, strong)
            c.drawRect(tx - 4f * s, y + 9f * s, tx + w + 4f * s, y + 10.5f * s, under)
            tx += w + 12f * s
            i = close + 1
        }
        y += 48f * s
        c.drawRect(x, y, x + 150f * s, y + 2f * s, oak)
        y += 44f * s + 30f * s
        c.drawText(L.t("emptyPhone"), x, y, hint)
    }
}

/** 没有 MV 的歌：深石板色的暗场，一圈水晶珠子（一颗木珠），歌名和歌手 */
class NoMvView(context: Context) : View(context) {
    var title = ""
        set(v) { field = v; invalidate() }
    var artist = ""
        set(v) { field = v; invalidate() }

    private val s = Art.s
    private val emblem = Emblem()
    private val bg = Paint(Paint.FILTER_BITMAP_FLAG)
    private val dst = RectF()
    private val name = Art.textPaint(64f, Art.FROST, 0.14f).apply { textAlign = Paint.Align.CENTER }
    private val by = Art.textPaint(28f, Color.parseColor("#A4A6A8"), 0.36f).apply { textAlign = Paint.Align.CENTER }
    private val lineColor = Color.parseColor("#C9CCCF")

    override fun onDraw(c: Canvas) {
        dst.set(0f, 0f, width.toFloat(), height.toFloat())
        c.drawBitmap(Art.roomBackground(), null, dst, bg)
        val cx = width / 2f
        emblem.draw(c, cx - 170f * s, 120f * s, 340f * s, lineColor, 1f, Art.OAT, glass = true)
        c.drawText(title, cx, 520f * s + 62f * s, name)
        if (artist.isNotEmpty()) c.drawText(artist, cx, 618f * s + 28f * s, by)
    }
}

/**
 * 手机点歌卡片（v7）：左边木框里一个大二维码，右边几行说明和备用网址。
 * 返回或确认关掉；方向键不动。
 */
class QrCard(context: Context) : View(context) {
    var onClose: () -> Unit = {}
    var address = ""
        set(v) { if (v != field) { field = v; qr = null }; invalidate() }

    private val s = Art.s
    private var qr: Bitmap? = null
    private val backdrop = Paint().apply { color = Color.argb(209, 232, 231, 228) }
    private val card = Paint().apply { color = Art.CARD }
    private val shadow = Paint().apply { color = Color.argb(36, 0, 0, 0) }
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 2f * s; color = Art.INK }
    private val frame = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = 6f * s; color = Art.INDIGO }
    private val white = Paint().apply { color = Color.WHITE }
    private val oak = Paint().apply { color = Art.INDIGO }
    private val crisp = Paint() // 不过滤：二维码边缘要锐利
    private val dst = RectF()
    private val small = Art.textPaint(24f, Art.GREY, 0.2f)
    private val title = Art.textPaint(60f, Art.INK, 0.08f)
    private val body = TextPaint(Art.textPaint(30f, Art.INK, 0.03f))
    private val wifi = Art.textPaint(27f, Art.GREY, 0.03f)
    private val fallback = Art.textPaint(24f, Art.GREY, 0.04f)
    private val addr = Art.textPaint(34f, Art.INK, 0.04f)

    init { isFocusable = true }

    private fun top(p: Paint, y: Float) = y * s - p.ascent()

    override fun onDraw(c: Canvas) {
        val en = L.isEnglish
        c.drawRect(0f, 152f * s, width.toFloat(), (152f + 796f) * s, backdrop)
        val l = 340f * s; val t = 232f * s; val r = l + 1240f * s; val b = t + 576f * s
        c.drawRect(l, t + 10f * s, r, b + 10f * s, shadow)
        c.drawRect(l, t, r, b, card)
        c.drawRect(l, t, r, b, border)

        // 木框 + 白底 + 二维码
        c.drawRect(403f * s, 295f * s, 853f * s, 745f * s, frame)
        c.drawRect(406f * s, 298f * s, 850f * s, 742f * s, white)
        val box = 348f * s
        if (address.isNotEmpty()) {
            val bm = qr ?: Qr.bitmap("http://$address/", 1).also { qr = it }
            // 每格整数像素，在 348 的方块里居中
            val unit = kotlin.math.floor(box / bm.width)
            val side = unit * bm.width
            val x0 = 454f * s + (box - side) / 2; val y0 = 346f * s + (box - side) / 2
            dst.set(x0, y0, x0 + side, y0 + side)
            c.drawBitmap(bm, null, dst, crisp)
        }

        // 右边的字
        val x = 920f * s
        c.drawText(L.t("phoneChip"), x, top(small, 303f), small)
        title.textSize = (if (en) 52f else 60f) * s
        c.drawText(L.t("qrTitle"), x, top(title, 351f), title)
        @Suppress("DEPRECATION")
        val layout = StaticLayout(L.t("qrSub"), body, (600f * s).toInt(), Layout.Alignment.ALIGN_NORMAL, 1f, 10f * s, false)
        c.save(); c.translate(x, 449f * s); layout.draw(c); c.restore()
        c.drawText(L.t("qrWifi"), x, top(wifi, 552f), wifi)
        c.drawRect(x, 628f * s, x + 150f * s, 630f * s, oak)
        c.drawText(L.t("qrFallback"), x, top(fallback, 658f), fallback)
        c.drawText(if (address.isEmpty()) L.t("qrNoNet") else address, x, top(addr, 694f), addr)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = when (keyCode) {
        KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> true
        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> { onClose(); true }
        else -> super.onKeyDown(keyCode, event)
    }
}
