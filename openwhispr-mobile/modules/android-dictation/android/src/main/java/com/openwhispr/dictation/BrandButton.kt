package com.openwhispr.dictation

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.widget.TextView

/** Same ring and waveform geometry as the shared OpenWhisprMark component. */
class BrandButton(context: Context) : TextView(context) {
  override fun getAccessibilityClassName(): CharSequence = android.widget.Button::class.java.name
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE; style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND
  }
  override fun onDraw(canvas: Canvas) {
    if (text.isNotEmpty()) { super.onDraw(canvas); return }
    val size = minOf(width, height) * 0.56f
    canvas.save(); canvas.translate((width - size) / 2, (height - size) / 2)
    canvas.scale(size / 41.23f, size / 41.23f)
    stroke.strokeWidth = 3.456f
    canvas.drawCircle(20.617f, 20.617f, 18.889f, stroke)
    stroke.strokeWidth = 4.246f
    canvas.drawLine(13.86f, 17.39f, 13.86f, 23.91f, stroke)
    canvas.drawLine(20.61f, 13.04f, 20.61f, 28.19f, stroke)
    canvas.drawLine(27.37f, 17.39f, 27.37f, 23.91f, stroke)
    canvas.restore()
  }
}
