const fs = require('fs');
const path = require('path');

const packagePath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

function fail(message) {
	console.error(`Cannot publish: ${message}`);
	process.exit(1);
}

if (pkg.private) {
	fail('remove "private" from package.json before publishing.');
}

if (!/^insomnia-plugin-[a-z0-9-]+$/.test(pkg.name)) {
	fail('name must match insomnia-plugin-<lowercase-name>.');
}

if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) {
	fail('version must be numeric major.minor.patch.');
}

if (pkg.main !== 'main.js' || !fs.existsSync(path.join(__dirname, '..', 'main.js'))) {
	fail('main.js must be the package entry point.');
}

if (!pkg.insomnia || !pkg.insomnia.name || !pkg.insomnia.description) {
	fail('insomnia.name and insomnia.description are required.');
}

console.log(`Ready to publish ${pkg.name}@${pkg.version}`);
