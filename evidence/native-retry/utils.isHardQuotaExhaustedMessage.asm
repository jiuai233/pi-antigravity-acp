google3/third_party/jetski/cortex/utils/utils.isHardQuotaExhaustedMessage 0x14172cc20 size=224
0x14172cc20 cmp rsp, qword ptr [r14 + 0x10]
0x14172cc24 jbe 0x14172ccda
0x14172cc2a push rbp
0x14172cc2b mov rbp, rsp
0x14172cc2e sub rsp, 0x30
0x14172cc32 mov qword ptr [rsp + 0x40], rax
0x14172cc37 call 0x140161fe0 ; strings.ToLower
0x14172cc3c mov qword ptr [rsp + 0x28], rax
0x14172cc41 mov qword ptr [rsp + 0x20], rbx
0x14172cc46 lea rcx, [rip + 0x29ffb3b] ; b'per daystep %doutputsTIMEOUT.coffee.cshtml.gradle.groovy.svelteclojurefortrangra'
0x14172cc4d mov edi, 7
0x14172cc52 call 0x140015200 ; internal/stringslite.Index
0x14172cc57 test rax, rax
0x14172cc5a jl 0x14172cc63
0x14172cc5c mov edx, 1
0x14172cc61 jmp 0x14172cc84
0x14172cc63 mov rax, qword ptr [rsp + 0x28]
0x14172cc68 mov rbx, qword ptr [rsp + 0x20]
0x14172cc6d lea rcx, [rip + 0x29df79c] ; b'daily.citcfile:--getanyOfoneOf$defscells.bash.dart.diff.java.less.lisp.sass.scss'
0x14172cc74 mov edi, 5
0x14172cc79 call 0x140015200 ; internal/stringslite.Index
0x14172cc7e test rax, rax
0x14172cc81 setge dl
0x14172cc84 test dl, dl
0x14172cc86 je 0x14172cc8f
0x14172cc88 mov eax, 1
0x14172cc8d jmp 0x14172ccd8
0x14172cc8f mov rax, qword ptr [rsp + 0x28]
0x14172cc94 mov rbx, qword ptr [rsp + 0x20]
0x14172cc99 lea rcx, [rip + 0x2ac6b50] ; b'billing accountQUOTA_EXHAUSTEDDocument ID: %v, Logs Path: %sDescription: %sDynam'
0x14172cca0 mov edi, 0xf
0x14172cca5 call 0x140015200 ; internal/stringslite.Index
0x14172ccaa test rax, rax
0x14172ccad jl 0x14172ccb6
0x14172ccaf mov eax, 1
0x14172ccb4 jmp 0x14172ccd8
0x14172ccb6 nop 
0x14172ccb7 mov rax, qword ptr [rsp + 0x28]
0x14172ccbc mov rbx, qword ptr [rsp + 0x20]
0x14172ccc1 lea rcx, [rip + 0x2b73195] ; b'individual quota reachedcontext canceled by userANTIGRAVITY_AGENTAPI_EXEMODEL_CA'
0x14172ccc8 mov edi, 0x18
0x14172cccd call 0x140015200 ; internal/stringslite.Index
0x14172ccd2 test rax, rax
0x14172ccd5 setge al
0x14172ccd8 leave 
0x14172ccd9 ret 
0x14172ccda mov qword ptr [rsp + 8], rax
0x14172ccdf mov qword ptr [rsp + 0x10], rbx
0x14172cce4 call 0x1400965c0 ; runtime.morestack_noctxt
0x14172cce9 mov rax, qword ptr [rsp + 8]
0x14172ccee mov rbx, qword ptr [rsp + 0x10]
0x14172ccf3 jmp 0x14172cc20
0x14172ccf8 int3 
0x14172ccf9 int3 
0x14172ccfa int3 
0x14172ccfb int3 
0x14172ccfc int3 
0x14172ccfd int3 
0x14172ccfe int3 
0x14172ccff int3 
