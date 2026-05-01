# Filestore

一个无需提交者登录的轻量级文件收集平台。

## 功能

- 管理员创建收集任务
- 自定义字段、正则校验、截止时间
- 通过随机链接提交表单和文件
- 限制文件类型、大小和数量
- 按表单字段自动重命名文件
- 管理提交记录、审核状态、删除错误提交
- 导出 CSV 汇总表、批量下载 ZIP 文件

## 启动

```powershell
python app.py
```

打开：

```text
http://127.0.0.1:8964
```

默认管理员密码：

```text
admin123
```

生产环境建议通过环境变量修改：

```powershell
$env:FILESTORE_ADMIN_PASSWORD="your-strong-password"
python app.py
```

数据默认保存在 `data/filestore.db`，上传文件保存在 `uploads/`。
