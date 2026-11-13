package com.banzou.ktv

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.SystemClock
import android.view.View

/**
 * 开场动画（约 3.4 秒，按任意键跳过）——照设计稿 v6 的 intro.html：
 * 深石板色的暗场 → 透明的珠子一颗一颗出现，围成一圈 → 最后一颗是木珠 → 整圈极慢地转一点
 * → 「波点」字距从宽收到位 → 一道细线、BODIAN → 淡到点歌页的纸色。
 * 每帧只画十几个圆、圆弧和几个字，不新建任何对象。
 */
class IntroView(context: Context, private val onDone: () -> Unit) : View(context) {
    private val start = SystemClock.uptimeMillis()
    private var finished = false
    private val total = 3400L

    private val s = Art.s
    private val emblem = Emblem()
    private val bgPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val dst = RectF()
    private val brandPaint = Art.textPaint(100f, Art.FROST).apply { typeface = android.graphics.Typeface.DEFAULT }
    private val latinPaint = Art.textPaint(28f, Color.parseColor("#A4A6A8"))
    private val rule = Paint().apply { color = Art.OAT }
    private val cover = Paint().apply { color = Art.PAPER }
    private val lineColor = Color.parseColor("#C9CCCF")

    // 名字一个字一个字画，字距才能动；字和宽度先算好
    private val brand = L.t("brand").map { it.toString() }.toTypedArray()
    private val brandW = FloatArray(brand.size) { brandPaint.measureText(brand[it]) }
    private val latin = L.t("brandLatin").map { it.toString() }.toTypedArray()
    private val latinW = FloatArray(latin.size) { latinPaint.measureText(latin[it]) }

    fun skip() {
        if (!finished) { finished = true; onDone() }
    }

    override fun onDraw(canvas: Canvas) {
        val t = (SystemClock.uptimeMillis() - start).coerceAtMost(total)
        val w = width.toFloat(); val h = height.toFloat()
        val cx = w / 2; val cy = 390f * s

        // 暗场 + 上方一片很淡的冷光（事先画好的一张图）
        dst.set(0f, 0f, w, h)
        canvas.drawBitmap(Art.roomBackground(), null, dst, bgPaint)

        // 珠子：从木珠的下一颗开始，顺时针一颗一颗出现；木珠最后。整圈慢慢转过约 9 度后停住
        val u = 3.4f * s
        canvas.save()
        canvas.rotate((ease(k01(t, 0, 3000)) - 1f) * 9.17f, cx, cy)
        for (n in 0 until Emblem.N) {
            val i = (Emblem.SOLID + 1 + n) % Emblem.N
            val solid = i == Emblem.SOLID
            val born = if (solid) 1500L else 250L + n * 105L
            val a = ease(k01(t, born, born + if (solid) 520L else 380L))
            if (a <= 0f) continue
            emblem.bead(canvas, cx + (Emblem.X[i] - 50f) * u, cy + (Emblem.Y[i] - 50f) * u, Emblem.R * u * (0.6f + 0.4f * a),
                lineColor, 2.6f * s, solid, Art.OAT, true, (a * 255).toInt())
        }
        canvas.restore()

        // 名字：字距从宽收到位，同时淡入
        val a1 = ease(k01(t, 1950, 2650))
        if (a1 > 0f) {
            brandPaint.alpha = (a1 * 255).toInt()
            spaced(canvas, brand, brandW, cx, 760f * s, (72f + (1f - a1) * 80f) * s, brandPaint)
        }
        // 一道细线从中间往两边长出来，再是拉丁字
        val a2 = ease(k01(t, 2300, 2900))
        if (a2 > 0f) {
            canvas.drawRect(cx - 100f * s * a2, 813f * s, cx + 100f * s * a2, 815f * s, rule)
            latinPaint.alpha = (a2 * 255).toInt()
            spaced(canvas, latin, latinW, cx, 868f * s, 24f * s, latinPaint)
        }

        // 结尾：淡到点歌页的纸色
        val out = k01(t, 3050, total)
        if (out > 0f) {
            cover.alpha = (out * 255).toInt()
            canvas.drawRect(0f, 0f, w, h, cover)
        }

        if (t >= total) skip() else postInvalidateOnAnimation()
    }

    private fun spaced(c: Canvas, chars: Array<String>, widths: FloatArray, cx: Float, y: Float, gap: Float, p: Paint) {
        var totalW = gap * (chars.size - 1)
        for (cw in widths) totalW += cw
        var x = cx - totalW / 2
        for (i in chars.indices) {
            c.drawText(chars[i], x, y, p)
            x += widths[i] + gap
        }
    }

    private fun k01(t: Long, a: Long, b: Long) = ((t - a).toFloat() / (b - a)).coerceIn(0f, 1f)
    private fun ease(x: Float) = 1f - (1f - x) * (1f - x) * (1f - x)
}
