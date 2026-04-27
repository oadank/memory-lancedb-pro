#!/usr/bin/env python3
import jieba, json, sys, re, os

text_file = sys.argv[1] if len(sys.argv) > 1 else ''
if not text_file or not os.path.exists(text_file):
    print('[]')
    sys.exit(0)

with open(text_file, 'r', encoding='utf-8') as f:
    text = f.read().strip()

stop = set(['的','了','在','是','我','有','和','就','不','都','一','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','那','里','什么','怎么','吧','啊','呢','吗','没','还','但','然后','好像','是不是','嗯','哦','个','把','被','让','给','从','中','过','一段','需要','这个','这些','那个','那些','一个','可能','应该','可以','所以','因为','如果','关于','对于','通过','没有','有没有','看看','刚刚','但是','改了'])
words = jieba.lcut(text)
eng = re.findall(r'[a-zA-Z][a-zA-Z0-9]+', text)
kw = list(set([w for w in words if len(w) >= 2 and w not in stop] + eng))
print(json.dumps(kw))
