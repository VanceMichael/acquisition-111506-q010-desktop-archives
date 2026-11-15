# 桌面资料迁移收件柜：合作来源契约

`GET /exports/17.plist`返回binary plist格式的合成NSKeyedArchiver，`GET /exports/17/metadata`返回预期长度、SHA256和来源记录时间。物理plist对象表索引与`plistlib.UID`引用索引不可混用；UID 0是空值约定，不是普通对象。对象有共享引用及一条循环引用，未知类留作惰性对象描述，不需构造来源类的实例。

支持binary plist中的null、bool、UID、integer、date、data、string、array、dict类型，以及NSKeyedArchiver的`$objects`、`$top`、`$class`、`$classname`和`$classes`约定。读取器只操作源字节和普通无行为结构，禁止反序列化后运行类方法。对象身份原样保存，业务投影只选择ArchiveEntry和ArchiveAsset；其他类原样保留以供复核。data是二进制字节而非文本，日期与整型语义需明确。

标准plist文档参考Apple公开归档对象图说明；本地最小数据与plistlib生成，确实以binary plist承载NSKeyedArchiver兼容字典。收件须核对文件边界、层级引用和外部SHA256；不信任元数据来执行代码。现有人工条目标识以archiveEntryId，新增结构可以关联物理对象位置、UID身份和来源类名称。不能因一条记录可解析而将损坏/不支持的其他对象宣告已完整接收。

## 来源与支持范围

格式参考：`https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/Archiving/Articles/objectgraphs.html`。这里运行的是只含虚构资料的本地合作端，不是公网生产服务；只需支持本文明确给出的范围。来源实现和样例可以阅读，自动接入应使用声明的交互入口，不把服务内部对象或预先写好的采集结论当作数据来源。原始依据、结构化内容和完整性状态应能在收件端回查；新增自动接口的名称与内部设计由开发者决定。
