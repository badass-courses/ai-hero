const fs = require('fs')
const path = require('path')
function show(label, p) {
	try { console.log('[debug]', label, '->', fs.realpathSync(p).split('.pnpm/')[1] || fs.realpathSync(p)) }
	catch (e) { console.log('[debug]', label, 'MISSING:', e.message.split('\n')[0]) }
}
show('app ui', path.join(__dirname, 'node_modules/@coursebuilder/ui'))
const ui = fs.realpathSync(path.join(__dirname, 'node_modules/@coursebuilder/ui'))
show('ui radix-popover', path.join(ui, '../../@radix-ui/react-popover'))
show('ui @types/react', path.join(ui, '../../@types/react'))
show('app @types/react', path.join(__dirname, 'node_modules/@types/react'))
try {
	const store = path.join(__dirname, '../../node_modules/.pnpm')
	console.log('[debug] popover instances:', fs.readdirSync(store).filter(d => d.startsWith('@radix-ui+react-popover')).join(' | '))
	console.log('[debug] types-react instances:', fs.readdirSync(store).filter(d => d.startsWith('@types+react@')).join(' | '))
} catch (e) { console.log('[debug] store listing failed:', e.message) }
