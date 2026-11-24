package expo.modules.morpharchive

import java.io.File
import java.io.RandomAccessFile
import java.util.Random

// ZIP codec tests (Android side, same check suite as tests/main.swift): ZipTestKt <working-dir>
// <python-archive-dir>. Written archives are verified against unzip and python (via
// scripts/test-native-archive.mjs). Reads python-generated archives and self-generated archives,
// and tests that malicious archives are correctly rejected.

var failures = 0
fun check(ok: Boolean, what: String) {
  if (!ok) {
    failures++
    println("FAIL: $what")
  }
}

fun source(file: File) = ZipSource(RandomAccessFile(file, "r").channel)

fun writeArchive(file: File, force: Boolean, files: List<Triple<String, ByteArray, Boolean>>) {
  val w = ZipWriter(file.path, force)
  for ((name, data, store) in files) {
    var at = 0
    w.add(name, data.size.toLong(), System.currentTimeMillis(), store, { buf ->
      // Supplied in multiple chunks to exercise multi-chunk code paths.
      val n = minOf(buf.size, data.size - at, 100_000)
      if (n <= 0) -1 else {
        System.arraycopy(data, at, buf, 0, n)
        at += n
        n
      }
    }, { false }, { })
  }
  w.finish()
}

fun readBack(file: File, work: File): Map<String, ByteArray> {
  val r = ZipReader(source(file))
  try {
    r.load()
    val out = File(work, "out-" + System.nanoTime())
    val result = HashMap<String, ByteArray>()
    for (e in r.entries) {
      val dest = File(out, e.name)
      r.extract(e, dest, { false }, { })
      result[e.name] = dest.readBytes()
    }
    out.deleteRecursively()
    return result
  } finally {
    r.close()
  }
}

fun main(args: Array<String>) {
  val work = File(args[0]).also { it.mkdirs() }
  val samples = File(args[1])
  val text = "Tinkrum 记录 ".repeat(5000).toByteArray()
  val noise = ByteArray(3_000_000).also { Random(1).nextBytes(it) }
  val files = listOf(
    Triple("tinkrum-backup.json", "{\"a\":1}".toByteArray(), false),
    Triple("database/morph.db", text, false),
    Triple("files/assets/ab12/photo.jpg", noise, true),
    Triple("files/assets/ab12/合同 (final).pdf", noise.copyOf(1000), true),
    Triple("files/assets/ab12/.text.txt", text, false),
    Triple("files/empty.txt", ByteArray(0), false),
    Triple("files/empty-stored.bin", ByteArray(0), true),
  )
  for ((label, force) in listOf("plain" to false, "zip64" to true)) {
    val f = File(work, "$label.zip")
    try {
      writeArchive(f, force, files)
      val back = readBack(f, work)
      check(back.size == files.size, "$label: entry count ${back.size}")
      for ((name, data, _) in files) check(back[name]?.contentEquals(data) == true, "$label: content of $name")
    } catch (e: Exception) {
      check(false, "$label: $e")
    }
  }
  try {
    val f = File(work, "many.zip")
    writeArchive(f, false, (0 until 70_000).map { Triple("files/n/$it.txt", "$it".toByteArray(), false) })
    val r = ZipReader(source(f))
    r.load()
    check(r.entries.size == 70_000, "many: ${r.entries.size}")
    r.close()
  } catch (e: Exception) {
    check(false, "many: $e")
  }
  val expected: Map<String, String?> = mapOf(
    "ok-deflate.zip" to null, "ok-zip64.zip" to null, "ok-stored.zip" to null,
    "bad-dotdot.zip" to "Unsafe:name", "bad-absolute.zip" to "Unsafe:name", "bad-backslash.zip" to "Unsafe:name",
    "bad-symlink.zip" to "Unsafe:special file", "bad-duplicate.zip" to "Unsafe:duplicate name",
    "bad-encrypted.zip" to "Unsupported:encrypted", "bad-method.zip" to "Unsupported:method 12",
    "bad-notzip.zip" to "NotZip", "bad-truncated.zip" to "NotZip",
    "bad-crc.zip" to "Damaged:crc", "bad-size-lie.zip" to "Damaged:size", "bad-bomb-lie.zip" to "Damaged:size",
  )
  for ((name, want) in expected) {
    try {
      val back = readBack(File(samples, name), work)
      check(want == null, "$name: should have been refused, extracted ${back.size}")
      if (want == null) check(back["files/hello.txt"]?.contentEquals("hello 你好\n".toByteArray()) == true, "$name: content")
    } catch (e: ZipFail) {
      val got = when (e) {
        is ZipFail.NotZip -> "NotZip"
        is ZipFail.Unsafe -> "Unsafe:${e.message}"
        is ZipFail.Unsupported -> "Unsupported:${e.message}"
        is ZipFail.Damaged -> "Damaged:${e.message}"
        else -> e.toString()
      }
      check(want == got, "$name: got $got, want $want")
    }
  }
  // Cancellation.
  try {
    val w = ZipWriter(File(work, "cancel.zip").path)
    var calls = 0
    try {
      w.add("a.bin", 5_000_000, 0, true, { buf -> buf.size }, { calls++ > 2 }, { })
      check(false, "cancel: not cancelled")
    } catch (e: ZipFail.Cancelled) {
    }
    w.abort()
  } catch (e: Exception) {
    check(false, "cancel: $e")
  }
  if (args.size > 2 && args[2] == "big") {
    val f = File(work, "big.zip")
    val total = 4_200_000_000L
    var sent = 0L
    val w = ZipWriter(f.path)
    w.add("files/huge.bin", total, 0, false, { buf ->
      val n = minOf(buf.size.toLong(), total - sent).toInt()
      java.util.Arrays.fill(buf, 0, n, 0)
      sent += n
      if (n <= 0) -1 else n
    }, { false }, { })
    w.finish()
    val r = ZipReader(source(f))
    r.load()
    check(r.entries.size == 1 && r.entries[0].size == total, "big: size")
    r.close()
  }
  println(if (failures == 0) "OK" else "$failures failure(s)")
  if (failures != 0) System.exit(1)
}
