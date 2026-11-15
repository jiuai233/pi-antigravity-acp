0x1431de16e: mov rdx, qword ptr [rsp + 0x38]
0x1431de173: test rdx, rdx
0x1431de176: jne 0x1431de2a6
0x1431de17c: mov rdx, qword ptr [rsp + 0x60]
0x1431de181: test rdx, rdx
0x1431de184: je 0x1431de18c
0x1431de186: mov rsi, qword ptr [rdx + 0x38]
0x1431de18a: jmp 0x1431de191
0x1431de18c: mov esi, 0
0x1431de191: je 0x1431de199
0x1431de193: mov rdx, qword ptr [rdx + 0x10]
0x1431de197: jmp 0x1431de1a0
0x1431de199: xor edx, edx
0x1431de19b: nop dword ptr [rax + rax]
0x1431de1a0: cmp rsi, rdx
0x1431de1a3: jbe 0x1431de26a
0x1431de1a9: mov rdx, qword ptr [rsp + 0x58]
0x1431de1ae: mov qword ptr [rdi + 0x28], rdx
0x1431de1b2: mov rdx, qword ptr [rsp + 0x50]
0x1431de1b7: mov qword ptr [rdi + 0x30], rdx
0x1431de1bb: cmp dword ptr [rip + 0xb29816e], 0
0x1431de1c2: jne 0x1431de1ce
0x1431de1c4: mov rsi, qword ptr [rsp + 0x90]
0x1431de1cc: jmp 0x1431de1e6
0x1431de1ce: mov rdx, qword ptr [rdi + 0x38]
0x1431de1d2: call 0x140098200
0x1431de1d7: mov rsi, qword ptr [rsp + 0x90]
0x1431de1df: mov qword ptr [r11], rsi
0x1431de1e2: mov qword ptr [r11 + 8], rdx
0x1431de1e6: mov qword ptr [rdi + 0x38], rsi
0x1431de1ea: mov rdx, qword ptr [rdi + 0x48]
0x1431de1ee: dec rdx
0x1431de1f1: mov qword ptr [rdi + 0x48], rdx
0x1431de1f5: test rdx, rdx
0x1431de1f8: jg 0x1431de239
0x1431de1fa: mov rdx, qword ptr [rsp + 0xe0]
0x1431de202: mov rbx, qword ptr [rdx + 0x20]
0x1431de206: lea rax, [rip + 0x76093eb]
0x1431de20d: mov rcx, qword ptr [rsp + 0xe8]
0x1431de215: mov rdi, qword ptr [rsp + 0xf0]
0x1431de21d: nop dword ptr [rax]
0x1431de220: call 0x140011e80
0x1431de225: mov byte ptr [rsp + 0x37], 0
0x1431de22a: mov rdx, qword ptr [rsp + 0xc8]
0x1431de232: mov rsi, qword ptr [rdx]
0x1431de235: call rsi
0x1431de237: leave 
0x1431de238: ret 
0x1431de239: mov rax, qword ptr [rsp + 0xe0]
0x1431de241: mov rbx, qword ptr [rsp + 0xe8]
0x1431de249: mov rcx, qword ptr [rsp + 0xf0]
0x1431de251: call 0x1431ddba0
0x1431de256: mov byte ptr [rsp + 0x37], 0
0x1431de25b: mov rdx, qword ptr [rsp + 0xc8]
0x1431de263: mov rsi, qword ptr [rdx]
0x1431de266: call rsi
0x1431de268: leave 
0x1431de269: ret 
0x1431de26a: mov rdx, qword ptr [rsp + 0xe0]
0x1431de272: mov rbx, qword ptr [rdx + 0x20]
0x1431de276: lea rax, [rip + 0x760937b]
0x1431de27d: mov rcx, qword ptr [rsp + 0xe8]
0x1431de285: mov rdi, qword ptr [rsp + 0xf0]
0x1431de28d: call 0x140011e80
0x1431de292: mov byte ptr [rsp + 0x37], 0
0x1431de297: mov rdx, qword ptr [rsp + 0xc8]
0x1431de29f: mov rsi, qword ptr [rdx]
0x1431de2a2: call rsi
0x1431de2a4: leave 
0x1431de2a5: ret 
0x1431de2a6: mov rdx, qword ptr [rsp + 0xe0]
0x1431de2ae: mov rbx, qword ptr [rdx + 0x20]
0x1431de2b2: lea rax, [rip + 0x760933f]
0x1431de2b9: mov rcx, qword ptr [rsp + 0xe8]
0x1431de2c1: mov rdi, qword ptr [rsp + 0xf0]
0x1431de2c9: call 0x140011e80
0x1431de2ce: mov byte ptr [rsp + 0x37], 0
0x1431de2d3: mov rdx, qword ptr [rsp + 0xc8]
0x1431de2db: mov rsi, qword ptr [rdx]
0x1431de2de: nop 
0x1431de2e0: call rsi
0x1431de2e2: leave 
0x1431de2e3: ret 
0x1431de2e4: mov byte ptr [rsp + 0x37], 0
0x1431de2e9: mov rdx, qword ptr [rsp + 0xc8]
0x1431de2f1: mov rax, qword ptr [rdx]