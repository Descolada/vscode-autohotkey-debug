﻿#SingleInstance
#Persistent

str := "abc"
num := 123
obj := { key: "value", "3": "100" }
arr := [ 1, 10, 100 ]
nestedObj := { a: { b: { obj: obj, arr: arr } } }
return