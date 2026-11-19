## 1. Objetivo

A API tem como objetivo receber operações de apostas e atualizar carteiras sem duplicar movimentações. 
O banco é a principal fonte de acertividade para decisões da aplicação, considerando saldo, transações e lançamentos.
Mesmo com mensagens repetidas, atrasadas ou processadas ao mesmo tempo, a API e seus dados devem continuar funcionando integralmente.

## 2. Desenho geral:
