package com.banzou.ktv

import android.graphics.Bitmap
import android.graphics.Color
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

/** 手机扫码打开遥控页：把网址画成二维码（炭黑格子、白底） */
object Qr {
    /** 不带留白（留白由卡片的白底给）；每格 unit 像素，画的时候再按整数倍放大，边缘才锐利 */
    fun bitmap(text: String, unit: Int, dark: Int = Art.INK, light: Int = Color.WHITE): Bitmap {
        val hints = mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 0)
        val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints) // 0,0 = 每格 1 像素
        val side = m.width * unit
        val px = IntArray(side * side)
        for (y in 0 until side) for (x in 0 until side) px[y * side + x] = if (m.get(x / unit, y / unit)) dark else light
        return Bitmap.createBitmap(px, side, side, Bitmap.Config.ARGB_8888)
    }
}
