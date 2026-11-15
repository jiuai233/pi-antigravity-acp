0x1431de518: mov rcx, qword ptr [rax + 0x30]
0x1431de51c: mov rax, qword ptr [rsp + 0x40]
0x1431de521: call rcx
0x1431de523: test al, al
0x1431de525: je 0x1431de5a3
0x1431de527: mov rcx, qword ptr [rsp + 0x20]
0x1431de52c: mov rcx, qword ptr [rcx + 0x28]
0x1431de530: mov rax, qword ptr [rsp + 0x40]
0x1431de535: call rcx
0x1431de537: test rax, rax
0x1431de53a: je 0x1431de542
0x1431de53c: mov rcx, qword ptr [rax + 0x48]
0x1431de540: jmp 0x1431de544
0x1431de542: xor ecx, ecx
0x1431de544: test rcx, rcx
0x1431de547: je 0x1431de54f
0x1431de549: mov rbx, qword ptr [rcx + 0x38]
0x1431de54d: jmp 0x1431de551
0x1431de54f: xor ebx, ebx
0x1431de551: test rbx, rbx
0x1431de554: jne 0x1431de569
0x1431de556: test rcx, rcx
0x1431de559: je 0x1431de562
0x1431de55b: mov rbx, qword ptr [rcx + 0x10]
0x1431de55f: nop 
0x1431de560: jmp 0x1431de564
0x1431de562: xor ebx, ebx
0x1431de564: test rbx, rbx
0x1431de567: je 0x1431de513
0x1431de569: mov qword ptr [rsp + 0x38], rcx
0x1431de56e: movups xmmword ptr [rsp + 0x28], xmm15
0x1431de574: mov byte ptr [rsp + 0x1f], 1
0x1431de579: mov rdx, qword ptr [rsp + 0x78]
0x1431de57e: mov rax, qword ptr [rdx]
0x1431de581: call rax
0x1431de583: mov byte ptr [rsp + 0x1f], 0
0x1431de588: mov rdx, qword ptr [rsp + 0x70]
0x1431de58d: mov rax, qword ptr [rdx]
0x1431de590: call rax
0x1431de592: mov rbx, qword ptr [rsp + 0x28]
0x1431de597: mov rax, qword ptr [rsp + 0x38]
0x1431de59c: mov rcx, qword ptr [rsp + 0x30]
0x1431de5a1: leave 
0x1431de5a2: ret 
0x1431de5a3: mov rcx, qword ptr [rsp + 0x20]
0x1431de5a8: mov rcx, qword ptr [rcx + 0x20]
0x1431de5ac: mov rax, qword ptr [rsp + 0x40]
0x1431de5b1: call rcx
0x1431de5b3: test rax, rax
0x1431de5b6: je 0x1431de5f8
0x1431de5b8: movq qword ptr [rsp + 0x38], xmm15
0x1431de5bf: mov qword ptr [rsp + 0x28], rax
0x1431de5c4: mov qword ptr [rsp + 0x30], rbx
0x1431de5c9: mov byte ptr [rsp + 0x1f], 1
0x1431de5ce: mov rdx, qword ptr [rsp + 0x78]
0x1431de5d3: mov rax, qword ptr [rdx]
0x1431de5d6: call rax
0x1431de5d8: mov byte ptr [rsp + 0x1f], 0
0x1431de5dd: mov rdx, qword ptr [rsp + 0x70]
0x1431de5e2: mov rax, qword ptr [rdx]
0x1431de5e5: call rax
0x1431de5e7: mov rbx, qword ptr [rsp + 0x28]
0x1431de5ec: mov rax, qword ptr [rsp + 0x38]
0x1431de5f1: mov rcx, qword ptr [rsp + 0x30]
0x1431de5f6: leave 
0x1431de5f7: ret 
0x1431de5f8: mov eax, 1
0x1431de5fd: lea rbx, [rip + 0x104114f]
0x1431de604: mov ecx, 0x1c
0x1431de609: call 0x140a05c40
0x1431de60e: movq qword ptr [rsp + 0x38], xmm15
0x1431de615: mov qword ptr [rsp + 0x28], rax
0x1431de61a: mov qword ptr [rsp + 0x30], rbx
0x1431de61f: mov byte ptr [rsp + 0x1f], 1
0x1431de624: mov rdx, qword ptr [rsp + 0x78]
0x1431de629: mov rsi, qword ptr [rdx]
0x1431de62c: call rsi
0x1431de62e: mov byte ptr [rsp + 0x1f], 0
0x1431de633: mov rdx, qword ptr [rsp + 0x70]