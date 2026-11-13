package com.banzou.ktv

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.view.View
import kotlin.math.max

/**
 * KTV 歌词：屏幕下方两行，上一行靠左、下一行靠右，交替出现。
 * 正在唱的那句从左到右变色（霜白 → 冰蓝），两种颜色外面都是一圈石墨色描边。
 * 第一句之前显示一张歌名卡片和倒数的圆点。
 */
class LyricsView(context: Context) : View(context) {
    var lyrics: Lyrics = Lyrics.EMPTY
        set(v) { field = v; clearCache(); dropCard(); invalidate() }
    var title: String = ""
        set(v) { field = v; dropCard() }
    var artist: String = ""
    /** 暂停卡片开着时不画歌名卡片，免得两张叠在一起 */
    var hideCard = false
        set(v) { field = v; dropCard() }
    /** 返回当前播放位置（毫秒）；[NOT_PLAYING] 表示没在放。（用接口而不是 lambda：每帧都要调，不想每次装箱一个 Long） */
    fun interface Clock { fun now(): Long }
    var clock: Clock? = null

    // 描边：把字往四周各挪一点画很多遍深色（外圈 16 个方向、内圈 8 个方向），再画本色。
    // （不能用「描线」的画法：这台电视上加粗的字描线和填色的字宽不一样，会错位。）
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { typeface = Typeface.DEFAULT; isFakeBoldText = true }
    private var outline = 4f
    private val ringX = FloatArray(24) { (if (it < 16) kotlin.math.cos(it * Math.PI / 8) else 0.5 * kotlin.math.cos((it - 16) * Math.PI / 4)).toFloat() }
    private val ringY = FloatArray(24) { (if (it < 16) kotlin.math.sin(it * Math.PI / 8) else 0.5 * kotlin.math.sin((it - 16) * Math.PI / 4)).toFloat() }

    // 每句字先画成图片缓存起来，每帧只贴图，老电视也不吃力。
    // 没唱到的、唱过的各一份，直接用那句歌词当键（每帧查的时候不用拼字符串）
    private fun newCache() = object : LinkedHashMap<String, Bitmap>(16, 0.75f, true) {
        override fun removeEldestEntry(e: MutableMap.MutableEntry<String, Bitmap>): Boolean =
            (size > 6).also { if (it) e.value.recycle() }
    }
    private val restCache = newCache()
    private val sungCache = newCache()
    private var cachedSize = 0f
    private val fm = Paint.FontMetrics()

    private fun clearCache() {
        restCache.values.forEach { it.recycle() }; restCache.clear()
        sungCache.values.forEach { it.recycle() }; sungCache.clear()
    }

    private fun outlined(canvas: Canvas, text: String, x: Float, y: Float, sung: Boolean) {
        val cache = if (sung) sungCache else restCache
        val body = if (sung) sungFill else restFill
        val pad = outline.toInt() + 3
        fill.getFontMetrics(fm)
        val bmp = cache[text] ?: run {
            val b = Bitmap.createBitmap(fill.measureText(text).toInt() + pad * 2, (fm.descent - fm.ascent).toInt() + pad * 2, Bitmap.Config.ARGB_8888)
            val c = Canvas(b)
            val by = pad - fm.ascent
            fill.color = edge
            for (i in ringX.indices) c.drawText(text, pad + ringX[i] * outline, by + ringY[i] * outline, fill)
            fill.color = body
            c.drawText(text, pad.toFloat(), by, fill)
            cache[text] = b
            b
        }
        canvas.drawBitmap(bmp, x - pad, y + fm.ascent - pad, null)
    }

    private val sungFill = Art.LYRIC_SUNG
    private val restFill = Art.LYRIC
    private val edge = Art.LYRIC_EDGE

    // 倒数的圆点
    private val dotFill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Art.LYRIC }
    private val dotEdge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = Art.LYRIC_EDGE }

    override fun onDraw(canvas: Canvas) {
        val t = clock?.now() ?: return
        if (t == NOT_PLAYING) return
        val lines = lyrics.lines
        val h = height.toFloat()
        val w = width.toFloat()
        val size = h * 0.068f
        setSize(size)
        if (cachedSize != size) { clearCache(); cachedSize = size }
        val margin = w * 0.08f
        val y0 = h * 0.80f
        val y1 = y0 + size * 1.45f

        // 片头：歌名卡片，在第一句前面显示
        val first = lines.firstOrNull()?.startMs ?: Long.MAX_VALUE
        if (!hideCard && t < first - 4000 && t < 12000) {
            val c = card ?: buildCard(w).also { card = it }
            canvas.drawBitmap(c, (w - c.width) / 2, 430f * Art.s - (c.height - 10f * Art.s) / 2, null)
        }

        if (lines.isEmpty()) { postInvalidateOnAnimation(); return }
        var cur = -1
        for (i in lines.indices) { if (lines[i].startMs <= t) cur = i else break }

        // 两个位置：偶数句在上（靠左），奇数句在下（靠右）
        val top = if (cur < 0) 0 else if (cur % 2 == 0) cur else cur + 1
        val bottom = if (cur < 0) 1 else if (cur % 2 == 1) cur else cur + 1
        drawLine(canvas, top, t, margin, y0, leftAlign = true, w = w)
        drawLine(canvas, bottom, t, w - margin, y1, leftAlign = false, w = w)

        // 第一句前的倒数点
        if (cur < 0 && first - t in 0..4000) {
            val dots = ((first - t) / 1000 + 1).toInt().coerceAtMost(4)
            val r = size * 0.2f
            dotEdge.strokeWidth = size * 0.13f
            for (i in 0 until dots) {
                val cx = margin + size * 0.35f + i * size * 0.8f
                val cy = y0 - size * 1.25f
                canvas.drawCircle(cx, cy, r, dotEdge)
                canvas.drawCircle(cx, cy, r, dotFill)
            }
        }
        postInvalidateOnAnimation()
    }

    private fun drawLine(canvas: Canvas, i: Int, t: Long, x: Float, y: Float, leftAlign: Boolean, w: Float) {
        val lines = lyrics.lines
        if (i !in lines.indices) return
        val text = lines[i].text
        val tw = fill.measureText(text)
        val left = if (leftAlign) x else x - tw
        val p = progress(i, t)
        // 没唱到的部分
        if (p < 1f) {
            canvas.save()
            canvas.clipRect(left + tw * p, 0f, w, height.toFloat())
            outlined(canvas, text, left, y, false)
            canvas.restore()
        }
        // 唱过的部分
        if (p > 0f) {
            canvas.save()
            canvas.clipRect(0f, 0f, left + tw * p, height.toFloat())
            outlined(canvas, text, left, y, true)
            canvas.restore()
        }
    }

    /** 这句唱到哪了（0..1）。歌词只有每句的开始时间，按字数估计这句唱多久。 */
    private fun progress(i: Int, t: Long): Float {
        val lines = lyrics.lines
        val start = lines[i].startMs
        if (t < start) return 0f
        val gap = (lines.getOrNull(i + 1)?.startMs ?: (start + 8000)) - start
        val est = lines[i].text.sumOf { c ->
            when {
                Character.isIdeographic(c.code) -> 420L
                c.isWhitespace() -> 60L
                c.isLetterOrDigit() -> 85L
                else -> 0L
            }
        }
        val dur = minOf(gap * 0.92, est * 1.7 + 300.0).coerceAtLeast(400.0)
        return ((t - start) / dur).toFloat().coerceIn(0f, 1f)
    }

    private fun setSize(s: Float) {
        fill.textSize = s; outline = s * 0.105f
    }

    // ---------- 歌名卡片：一张浅色的纸，一圈细线；徽记、歌名、歌手、一道短线、词曲。每首歌只画一次 ----------

    private var card: Bitmap? = null

    private fun dropCard() { card?.recycle(); card = null }

    companion object {
        const val NOT_PLAYING = Long.MIN_VALUE
    }

    private fun buildCard(screenW: Float): Bitmap {
        val s = Art.s
        val credits = lyrics.credits.filter { !it.contains(" - ") }.take(4)
        val titleP = Art.textPaint(100f, Art.INK, 0.1f).apply { textAlign = Paint.Align.CENTER }
        // 歌名太长就缩小，最宽占屏幕的七成
        val maxTitle = screenW * 0.7f - 240f * s
        val tw0 = titleP.measureText(title)
        if (tw0 > maxTitle) titleP.textSize = titleP.textSize * maxTitle / tw0
        val artistP = Art.textPaint(40f, Art.GREY, 0.24f).apply { textAlign = Paint.Align.CENTER }
        val creditP = Art.textPaint(28f, Art.GREY, 0.08f).apply { textAlign = Paint.Align.CENTER }
        var inner = max(520f * s, titleP.measureText(title))
        for (c in credits) inner = max(inner, creditP.measureText(c))
        val w = inner + 240f * s
        var h = 56f * s + 64f * s + 24f * s + 120f * s
        if (artist.isNotEmpty()) h += 58f * s
        if (credits.isNotEmpty()) h += 36f * s + 2f * s + 28f * s + credits.size * 48f * s - 10f * s
        h += 60f * s
        val b = Bitmap.createBitmap(w.toInt() + 2, (h + 10f * s).toInt() + 2, Bitmap.Config.ARGB_8888)
        val c = Canvas(b)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        p.color = Color.argb(36, 0, 0, 0)
        c.drawRect(0f, 10f * s, w, h + 10f * s, p)
        p.color = Art.CARD
        c.drawRect(0f, 0f, w, h, p)
        p.style = Paint.Style.STROKE; p.strokeWidth = 2f * s; p.color = Art.INK
        c.drawRect(s, s, w - s, h - s, p)
        p.style = Paint.Style.FILL
        val cx = w / 2
        var y = 56f * s
        Emblem().draw(c, cx - 32f * s, y, 64f * s, Art.MID, 2.2f, Art.INDIGO)
        y += 64f * s + 24f * s + 98f * s
        c.drawText(title, cx, y, titleP)
        y += 22f * s
        if (artist.isNotEmpty()) { y += 44f * s; c.drawText(artist, cx, y, artistP); y += 14f * s }
        if (credits.isNotEmpty()) {
            y += 36f * s
            p.color = Art.INDIGO
            c.drawRect(cx - 75f * s, y, cx + 75f * s, y + 2f * s, p)
            y += 28f * s
            for (line in credits) { y += 36f * s; c.drawText(line, cx, y, creditP); y += 12f * s }
        }
        return b
    }
}
