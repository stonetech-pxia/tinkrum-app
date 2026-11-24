# Each ML Kit library contains its own copy of renamed internal classes, which are wired together at
# runtime via component registration. With R8 enabled in the release build, these classes would be
# merged and obfuscated, resulting in NullPointerExceptions on device (e.g., language recognition
# reading a class from another library). Prevent R8 from modifying the entire ML Kit.
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.internal.mlkit_** { *; }
# ONNX Runtime (D-269): native code looks up Java classes and methods by name; R8 must not rename or remove them.
-keep class ai.onnxruntime.** { *; }
# ML Kit entity extraction (pre-filling date and amount) brings in WorkManager: it uses Room
# reflection to instantiate WorkDatabase_Impl by name, and if R8 removes it, the app crashes on
# startup (Failed to create an instance of androidx.work.impl.WorkDatabase).
-keep class * extends androidx.room.RoomDatabase { <init>(); }
-keep class androidx.work.impl.WorkDatabase_Impl { *; }
