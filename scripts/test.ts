import Web3 from 'web3'
import { Contract } from 'web3-eth-contract'

const web3 = new Web3(web3Provider)

const libraries = {}

const MISC_ACC = 0
const NFTFI_ACC = 1
const BORROWER1_ACC = 2
const BORROWER2_ACC = 3
const STRUCTURER_ACC = 4
const INVESTOR1_ACC = 5
const INVESTOR2_ACC = 6
const INVESTOR3_ACC = 7
const INVESTOR4_ACC = 8
const INVESTOR5_ACC = 9
const LIQUIDATOR_ACC = 10

const APE_PRICE = '80000000000000000'; // 0.08 ETH, the initial BAYC release price
const TEN_ETH = '10000000000000000000';
const ADMIN_FEE = 500 // 500 bps, the current NFTfi admin fee
const CHAINID = 1;

interface Contracts {
    bayc: Contract,
    weth: Contract,
    nftfi: Contract,
    nftfiLoanCoord: Contract,
    nftfiPromNote: Contract,
    nftSec: Contract,
}

interface Accounts {
    misc: string,
    nftfi: string,
    borrower1: string,
    borrower2: string,
    structurer: string,
    investor1: string,
    investor2: string,
    investor3: string,
    investor4: string,
    investor5: string,
    liquidator: string,
}

// #region Helper methods

/* Get Remix-provided account address for the given index */
const getAccount = async (accountIndex: number): Promise<string> => {
    const accounts = await web3.eth.getAccounts()
    return accounts[accountIndex]
}

/* Deploy library contract and save its metadata globally for linking into top-level contracts */
const deployLibrary = async (
    libraryPath: string,
    libraryName: string,
    account: string,
): Promise<void> => {
    const artifactsPath = `browser/${libraryPath}/artifacts/${libraryName}.json`
    const metadata = JSON.parse(await remix.call('fileManager', 'getFile', artifactsPath))
    const contract = await (new web3.eth.Contract(metadata.abi))
        .deploy({data: metadata.data.bytecode.object})
        .send({from: account, gas: 10**9})
    const libraryFile = `${libraryPath}/${libraryName}.sol`
    libraries[libraryFile] = {}
    libraries[libraryFile][libraryName] = contract.options.address
    console.log(`Deployed ${libraryName} at address ${contract.options.address}`)
}

/* Deploy contract with the given arguments and return it */
const deploy = async (
    contractName: string,
    args: Array<any>,
    account: string,
): Promise<Contract> => {
    const artifactsPath = `browser/contracts/artifacts/${contractName}.json`
    const metadata = JSON.parse(await remix.call('fileManager', 'getFile', artifactsPath))
    let bytecode = metadata.data.bytecode.object
    const linkReferences = metadata.data.bytecode.linkReferences
    for (let libraryFile in linkReferences) {
        const fileReferences = linkReferences[libraryFile]
        for (let libraryName in fileReferences) {
            const occurrences = fileReferences[libraryName]
            for (let i = 0; i < occurrences.length; i++) {
                // Link previously deployed libraries by replacing placeholders in the compiled bytecode
                bytecode = (
                    bytecode.substring(0, 2 * occurrences[i].start)
                    + libraries[libraryFile][libraryName].substring(2)
                    + bytecode.substring(2 * occurrences[i].start + 40)
                )
            }
        }
    }
    const contract = await (new web3.eth.Contract(metadata.abi))
        .deploy({data: bytecode, arguments: args})
        .send({from: account, gas: 10**9})
    console.log(`Deployed ${contractName} at address ${contract.options.address}`)
    return contract
}

// #region Initializing contracts

/* Deploy BoredApeYachtClub contract and have the two borrowers each buy one */
const initBayc = async (accounts: Accounts): Promise<Contract> => {
    const bayc = await deploy('BoredApeYachtClub', ['BoredApeYachtClub', 'BAYC', 10000, 0], accounts.misc)
    await bayc.methods.flipSaleState().send({from: accounts.misc}) // Begin sale of apes

    // Borrowers buy apes
    await bayc.methods.mintApe(1).send({from: accounts.borrower1, value: APE_PRICE})
    await bayc.methods.mintApe(1).send({from: accounts.borrower2, value: APE_PRICE})

    // Verify the apes are bought
    const [bayc0Acc, bayc1Acc] = await Promise.all([
        bayc.methods.ownerOf(0).call(),
        bayc.methods.ownerOf(1).call(),
    ])
    if (bayc0Acc === accounts.borrower1) {
        console.log(`Bored Ape 0 purchased by Borrower 1`)
    }
    if (bayc1Acc === accounts.borrower2) {
        console.log(`Bored Ape 1 purchased by Borrower 2`)
    }

    return bayc
}

/* Deploy wETH contract */
const initWeth = async (accounts: Accounts): Promise<Contract> => {
    return deploy('WETH9', [], accounts.misc)
}

/* Deploy NFTfi libraries */
const initNftfiLibs = async (accounts: Accounts): Promise<void> => {
    await Promise.all([
        deployLibrary('contracts/loans/direct/loanTypes', 'LoanAirdropUtils', accounts.nftfi),
        deployLibrary('contracts/loans/direct/loanTypes', 'LoanChecksAndCalculations', accounts.nftfi),
        deployLibrary('contracts/utils', 'ContractKeys', accounts.nftfi),
        deployLibrary('contracts/utils', 'NFTfiSigningUtils', accounts.nftfi),
    ])
}

/* Deploy NFTfi hub for keeping track of NFTfi-related contracts */
const initNftfiHub = async (accounts: Accounts): Promise<Contract> => {
    return deploy('NftfiHub', [accounts.nftfi, [], []], accounts.nftfi)
}

/* Deploy NFTfi ERC721 wrapper contract for abstracting collateral transactions */
const initNftfiErc721Wrapper = async(accounts: Accounts): Promise<Contract> => {
    return deploy('ERC721Wrapper', [], accounts.nftfi)
}

/* Deploy NFTfi Permitted NFTs contract for registering collection permissions, and track it in the hub */
const initNftfiPermNfts = async (
    nftfiErc721Wrapper: Contract,
    nftfiHub: Contract,
    bayc: Contract,
    accounts: Accounts,
): Promise<void> => {
    const nftfiPermNfts = await deploy(
        'PermittedNFTsAndTypeRegistry',
        [
            accounts.nftfi,
            nftfiHub.options.address,
            ['BoredApeYachtClub'],
            [nftfiErc721Wrapper.options.address],
            [bayc.options.address],
            ['BoredApeYachtClub'],
        ],
        accounts.nftfi,
    )
    await nftfiHub.methods.setContract('PERMITTED_NFTS', nftfiPermNfts.options.address).send({from: accounts.nftfi})
}

/**
 * Deploy NFTfi Direct Loan Coordinator contract for registering loans, and track it in the hub.
 * Also, deploy SmartNft contracts representing the Promissory Note and Obligation Record, and initialize them
 * in the loan coordinator.
 */
const initNftfiLoanCoord = async (
    nftfiHub: Contract,
    nftfi: Contract,
    accounts: Accounts,
): Promise<[Contract, Contract]> => {
    const nftfiLoanCoord = await deploy(
        'DirectLoanCoordinator',
        [
            nftfiHub.options.address,
            accounts.nftfi,
            ['DIRECT_LOAN_FIXED_REDEPLOY'],
            [nftfi.options.address],
        ],
        accounts.nftfi,
    )
    const [nftfiPromNote, nftfiObliNote] = await Promise.all([
        deploy(
            'SmartNft',
            [
                accounts.nftfi,
                nftfiHub.options.address,
                nftfiLoanCoord.options.address,
                'NFTfi Promissory Note',
                'PNNFI',
                'https://metadata.nftfi.com/loans/v2/promissory/1/',
            ],
            accounts.nftfi,
        ),
        deploy(
            'SmartNft',
            [
                accounts.nftfi,
                nftfiHub.options.address,
                nftfiLoanCoord.options.address,
                'NFTfi Obligation Receipt',
                'ORNFI',
                'https://metadata.nftfi.com/loans/v2/obligation/1/',
            ],
            accounts.nftfi,
        ),
    ])
    await Promise.all([
        nftfiLoanCoord.methods.initialize(nftfiPromNote.options.address, nftfiObliNote.options.address).send({from: accounts.nftfi}),
        nftfiHub.methods.setContract('DIRECT_LOAN_COORDINATOR', nftfiLoanCoord.options.address).send({from: accounts.nftfi}),
    ])
    return [nftfiLoanCoord, nftfiPromNote]
}

/* Deploy Direct Loan contract, which is the main entry point for NFTfi interactions, and set its admin fee */
const initNiftfi = async (
    nftfiHub: Contract,
    weth: Contract,
    accounts: Accounts,
): Promise<Contract> => {
    const nftfi = await deploy('DirectLoanFixedOfferRedeploy', [accounts.nftfi, nftfiHub.options.address, [weth.options.address]], accounts.nftfi)
    await nftfi.methods.updateAdminFee(ADMIN_FEE).send({from: accounts.nftfi})
    return nftfi
}

/* Deploy NftSec contract, containing our securitized product logic */
const initNftSec = async (
    weth: Contract,
    nftfi: Contract,
    nftfiHub: Contract,
    nftfiErc721Wrapper: Contract,
    nftfiPermNote: Contract,
    accounts: Accounts
): Promise<Contract> => {
    return deploy(
        'NftSec',
        [
            weth.options.address,
            nftfi.options.address,
            nftfiHub.options.address,
            nftfiErc721Wrapper.options.address,
            nftfiPermNote.options.address,
            4,
            1,
        ],
        accounts.misc,
    )
}

/* Initialize all contracts and return a bundle of them for future use */
const init = async (accounts: Accounts): Promise<Contracts> => {
    console.log('\nStep 0: Initializing contracts...')
    await initNftfiLibs(accounts)
    const [bayc, weth, nftfiHub, nftfiErc721Wrapper] = await Promise.all([
        initBayc(accounts),
        initWeth(accounts),
        initNftfiHub(accounts),
        initNftfiErc721Wrapper(accounts),
    ])
    const nftfi = await initNiftfi(nftfiHub, weth, accounts)
    const [[nftfiLoanCoord, nftfiPromNote],] = await Promise.all([
        initNftfiLoanCoord(nftfiHub, nftfi, accounts),
        initNftfiPermNfts(nftfiErc721Wrapper, nftfiHub, bayc, accounts),
    ])
    const nftSec = await initNftSec(
        weth,
        nftfi,
        nftfiHub,
        nftfiErc721Wrapper,
        nftfiPromNote,
        accounts,
    )
    return {
        bayc: bayc,
        weth: weth,
        nftfi: nftfi,
        nftfiLoanCoord: nftfiLoanCoord,
        nftfiPromNote: nftfiPromNote,
        nftSec: nftSec,
    }
}

// #region Sourcing loans

/* Sign and accept an offer to initiate a loan on NFTfi */
const acceptOffer = async (
    contracts: Contracts,
    loanPrincipalAmount: string,
    maximumRepaymentAmount: string,
    nftCollateralId: number,
    loanDuration: number,
    nonce: number,
    structurerAcc: string,
    borrowerAcc: string,
): Promise<void> => {
    const referrer = '0x0000000000000000000000000000000000000000' // no referrer
    const expiry = 2 * 10**9 // expiry far in the future
    const data = web3.utils.soliditySha3(
        {t: 'address', v: contracts.weth.options.address},
        {t: 'uint256', v: loanPrincipalAmount},
        {t: 'uint256', v: maximumRepaymentAmount},
        {t: 'address', v: contracts.bayc.options.address},
        {t: 'uint256', v: nftCollateralId},
        {t: 'address', v: referrer},
        {t: 'uint32', v: loanDuration},
        {t: 'uint16', v: ADMIN_FEE},
        {t: 'address', v: structurerAcc},
        {t: 'uint256', v: nonce},
        {t: 'uint256', v: expiry},
        {t: 'address', v: contracts.nftfi.options.address},
        {t: 'uint256', v: CHAINID},
    )
    const [signature,] = await Promise.all([
        web3.eth.sign(data, structurerAcc), // structurer signs the offer
        contracts.bayc.methods.approve(contracts.nftfi.options.address, nftCollateralId).send({from: borrowerAcc}), // borrower approves NFT transfer
    ])
    await contracts.nftfi.methods.acceptOffer(
        [
            loanPrincipalAmount,
            maximumRepaymentAmount,
            nftCollateralId,
            contracts.bayc.options.address,
            loanDuration,
            ADMIN_FEE,
            contracts.weth.options.address,
            referrer,
        ],
        [
            nonce,
            expiry,
            structurerAcc,
            signature,
        ],
        [
            referrer,
            0,
        ]
    ).send({from: borrowerAcc})
}

/* Obtain wETH for account by depositing ETH */
const obtainWeth = async (contracts: Contracts, amount: string, account: string): Promise<void> => {
    await contracts.weth.methods.deposit().send({from: account, value: amount})
}

/* Get current wETH balance for account */
const getWethBalance = async (contracts: Contracts, account: string): Promise<number> => {
    return contracts.weth.methods.balanceOf(account).call()
}

/* Approve transfer of wETH to NFTfi from account */
const approveWethToNftfi = async (contracts: Contracts, amount: string, account: string): Promise<void> => {
    await contracts.weth.methods.approve(contracts.nftfi.options.address, amount).send({from: account})
}

/* Get current owner of promissory note associated with loanId */
const getLoanOwner = async (contracts: Contracts, loanId: number): Promise<string> => {
    const loanData = await contracts.nftfiLoanCoord.methods.getLoanData(loanId).call()
    return contracts.nftfiPromNote.methods.ownerOf(loanData[1]).call()
}

/* Initiate two NFTfi loans between structurer and borrowers */
const initiateLoans = async (
    contracts: Contracts,
    accounts: Accounts,
): Promise<void> => {
    console.log('\nStep 1: Initiating NFTfi loans...')
    await Promise.all([
        obtainWeth(contracts, TEN_ETH, accounts.structurer), // Obtain 10 wETH
        approveWethToNftfi(contracts, TEN_ETH, accounts.structurer) // Approve transfer of 10 wETH
    ])

    // Verify initial wETH balances
    await Promise.all([
        getWethBalance(contracts, accounts.structurer),
        getWethBalance(contracts, accounts.borrower1),
        getWethBalance(contracts, accounts.borrower2),
    ])
    .then(results => console.log(
        'wETH balances before NFTfi loans:',
        `\tStructurer: ${results[0]/10**18}`,
        `\tBorrower 1: ${results[1]/10**18}`,
        `\tBorrower 2: ${results[2]/10**18}`,
    ))

    // Initiate NFTfi loans
    await Promise.all([
        acceptOffer(
            contracts,
            '1000000000000000000', // 1 ETH principal
            '1100000000000000000', // 1.1 ETH repayment ==> 10% interest, not annualized
            0,
            25,
            0,
            accounts.structurer,
            accounts.borrower1,
        ),
        acceptOffer(
            contracts,
            '500000000000000000', // 0.5 ETH principal
            '700000000000000000', // 0.7 ETH repayment ==> 40% interest, not annualized
            1,
            12,
            1,
            accounts.structurer,
            accounts.borrower2,
        ),
    ]);

    // Verify final wETH balances and verify promissory notes successfully issued and verify collateral transferred
    await Promise.all([
        getLoanOwner(contracts, 1),
        getLoanOwner(contracts, 2),
        contracts.bayc.methods.ownerOf(0).call(),
        contracts.bayc.methods.ownerOf(1).call(),
        getWethBalance(contracts, accounts.structurer),
        getWethBalance(contracts, accounts.borrower1),
        getWethBalance(contracts, accounts.borrower2),
    ]).then(results => {
        if (results[0] === accounts.structurer) {
            console.log('NFTfi Promissory Note 1 issued to Structurer')
        }
        if (results[1] === accounts.structurer) {
            console.log('NFTfi Promissory Note 2 issued to Structurer')
        }
        if (results[2] === contracts.nftfi.options.address) {
            console.log('Bored Ape 0 transferred to NFTfi')
        }
        if (results[3] === contracts.nftfi.options.address) {
            console.log('Bored Ape 1 transferred to NFTfi')
        }
        console.log(
            'wETH balances after NFTfi loans:',
            `\tStructurer: ${results[4]/10**18}`,
            `\tBorrower 1: ${results[5]/10**18}`,
            `\tBorrower 2: ${results[6]/10**18}`,
        )
    })
}

// #region Minting tokens

/* Approve transfer of NFTfi Promissory Note to NftSec for minting tokens */
const approvePromNoteToNftSec = async (contracts: Contracts, accounts: Accounts, loanId: number): Promise<void> => {
    const loanData = await contracts.nftfiLoanCoord.methods.getLoanData(loanId).call()
    await contracts.nftfiPromNote.methods.approve(contracts.nftSec.options.address, loanData[1]).send({from: accounts.structurer})
}

/* Mint tranche tokens by sending NFTfi Promissory Notes to NftSec */
const mintTranches = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 2: Minting tranche tokens...')
    // Send NFTfi Promissory Notes
    await Promise.all([
        approvePromNoteToNftSec(contracts, accounts, 1),
        approvePromNoteToNftSec(contracts, accounts, 2),
    ])

    // Mint tranche tokens
    await contracts.nftSec.methods.mint(
        [1000, 2000], // interest rates of 10% and 20%
        ['600000000000000000', '800000000000000000'], // notional amounts of 0.6e18 and 0.9e18
        [1, 2],
        35,
        '100000000000000000', // residual price of 0.1 ETH
    ).send({from: accounts.structurer})

    // Verify promissory note ownership, as well as tranche token prices and quantities
    await Promise.all([
        getLoanOwner(contracts, 1),
        getLoanOwner(contracts, 2),
        contracts.nftSec.methods.getTokenQuantity(0, 0).call(),
        contracts.nftSec.methods.getTokenPrice(0, 0).call(),
        contracts.nftSec.methods.getTokenQuantity(0, 1).call(),
        contracts.nftSec.methods.getTokenPrice(0, 1).call(),
        contracts.nftSec.methods.getResidualPrice(0).call(),
    ]).then(results => {
        if (results[0] == contracts.nftSec.options.address) {
            console.log('NFTfi Promissory Note 1 transferred to NftSec')
        }
        if (results[1] == contracts.nftSec.options.address) {
            console.log('NFTfi Promissory Note 2 transferred to NftSec')
        }
        console.log(
            'Tranche tokens minted:',
            '\tSenior Tranche:',
            `\t\tQuantity - ${results[2]/10**18} x 10^18`,
            `\t\tPrice    - ${results[3]/10000} wei`,
            '\tJunior Tranche:',
            `\t\tQuantity - ${results[4]/10**18} x 10^18`,
            `\t\tPrice    - ${results[5]/10000} wei`,
            '\tResidual Tranche:',
            `\t\tPrice    - ${results[6]/10**18} ETH`,
        )
    })
}

// #region Investing in tranches

/* Approve transfer of wETH to NFTfi from account */
const approveWethToNftSec = async (contracts: Contracts, amount: string, account: string): Promise<void> => {
    await contracts.weth.methods.approve(contracts.nftSec.options.address, amount).send({from: account})
}

/* Investors invest in the various tranche tokens by paying wETH */
const investInTranches = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 3: Investing in tranche tokens...')

    // Obtain and approve transfer of 20 wETH for each investor
    await Promise.all([
        obtainWeth(contracts, TEN_ETH, accounts.investor1),
        obtainWeth(contracts, TEN_ETH, accounts.investor2),
        obtainWeth(contracts, TEN_ETH, accounts.investor3),
        obtainWeth(contracts, TEN_ETH, accounts.investor4),
        approveWethToNftSec(contracts, TEN_ETH, accounts.investor1),
        approveWethToNftSec(contracts, TEN_ETH, accounts.investor2),
        approveWethToNftSec(contracts, TEN_ETH, accounts.investor3),
        approveWethToNftSec(contracts, TEN_ETH, accounts.investor4),
    ])

    // Verify initial wETH balances
    await Promise.all([
        getWethBalance(contracts, accounts.structurer),
        getWethBalance(contracts, accounts.investor1),
        getWethBalance(contracts, accounts.investor2),
        getWethBalance(contracts, accounts.investor3),
        getWethBalance(contracts, accounts.investor4),
    ])
    .then(results => console.log(
        'wETH balances before tranche purchases:',
        `\tStructurer: ${results[0]/10**18}`,
        `\tInvestor 1: ${results[1]/10**18}`,
        `\tInvestor 2: ${results[2]/10**18}`,
        `\tInvestor 3: ${results[3]/10**18}`,
        `\tInvestor 4: ${results[4]/10**18}`,
    ))

    await Promise.all([
        contracts.nftSec.methods.buyTokens(0, 0, '600000000000000000').send({from: accounts.investor1}), // Investor 1 purchases entire senior tranche
        contracts.nftSec.methods.buyTokens(0, 1, '400000000000000000').send({from: accounts.investor2}), // Investor 2 purchases part of junior tranche
        contracts.nftSec.methods.buyResidual(0).send({from: accounts.investor3}), // Investor 3 purchases non-fungible resudiual tranche
    ])
    // After these purchases, only part of junior tranche remains for sale

    // Verify tranche tokens successfully purchased
    await Promise.all([
        contracts.nftSec.methods.balanceOf(accounts.investor1, 0).call(),
        contracts.nftSec.methods.balanceOf(accounts.investor2, 1).call(),
        contracts.nftSec.methods.balanceOf(accounts.investor3, 2).call(),
    ]).then(results => console.log(
        `Investor 1 purchased ${results[0]/10**18} x 10^18 senior tranche tokens`,
        `Investor 2 purchased ${results[1]/10**18} x 10^18 junior tranche tokens`,
        `Investor 3 purchased ${results[2]} residual tranche token`,
    ))

    console.log('Investor 4 is dissatisfied with the initial price of junior tranche, so she waits ---')
    for (let i = 0; i < 3; i++) {
        await new Promise(r => setTimeout(r, 1000))
        const juniorTranchePrice = await contracts.nftSec.methods.getTokenPrice(0, 1).call()
        console.log(`\tJunior tranche price is now ${juniorTranchePrice/10000} wei`)
    }
    await contracts.nftSec.methods.buyTokens(0, 1, '400000000000000000').send({from: accounts.investor4})

    // Verify final wETH balances
    await Promise.all([
        contracts.nftSec.methods.balanceOf(accounts.investor4, 1).call(),
        getWethBalance(contracts, accounts.structurer),
        getWethBalance(contracts, accounts.investor1),
        getWethBalance(contracts, accounts.investor2),
        getWethBalance(contracts, accounts.investor3),
        getWethBalance(contracts, accounts.investor4),
    ])
    .then(results => console.log(
        `Investor 4 purchased ${results[0]/10**18} x 10^18 junior tranche tokens`,
        'wETH balances after tranche purchases:',
        `\tStructurer: ${results[1]/10**18}`,
        `\tInvestor 1: ${results[2]/10**18}`,
        `\tInvestor 2: ${results[3]/10**18}`,
        `\tInvestor 3: ${results[4]/10**18}`,
        `\tInvestor 4: ${results[5]/10**18}`,
    ))
}

// #region Repaying loans

/* First borrower repays her loan to the structurer in wETH */
const repayLoan = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 4: Repaying loan...')

    await Promise.all([
        obtainWeth(contracts, TEN_ETH, accounts.borrower1), // Obtain more ETH for the borrower
        approveWethToNftfi(contracts, '1100000000000000000', accounts.borrower1) // Approve transfer of repayment amount to NFTfi
    ])

    // Verify initial wETH balances
    await Promise.all([
        getWethBalance(contracts, contracts.nftSec.options.address),
        getWethBalance(contracts, accounts.borrower1),
    ])
    .then(results => console.log(
        'wETH balances before repaying loan:',
        `\tNftSec contract: ${results[0]/10**18}`,
        `\tBorrower 1     : ${results[1]/10**18}`,
    ))

    console.log('Borrower 1 repaid her loan backed by Bored Ape 0')
    await contracts.nftfi.methods.payBackLoan(1).send({from: accounts.borrower1})

    // Verify final wETH balances
    await Promise.all([
        getWethBalance(contracts, contracts.nftSec.options.address),
        getWethBalance(contracts, accounts.borrower1),
    ])
    .then(results => console.log(
        'wETH balances after repaying loan:',
        `\tNftSec contract: ${results[0]/10**18}`,
        `\tBorrower 1     : ${results[1]/10**18}`,
    ))
}

// #region Liquidating collateral

/* Liquidator seizes NFT collateral for second loan which was not repaid in time */
const liquidateNft = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 5: Liquidating collateral...')

    await Promise.all([
        obtainWeth(contracts, TEN_ETH, accounts.liquidator),
        approveWethToNftSec(contracts, TEN_ETH, accounts.liquidator),
    ])

    // Verify initial wETH balances
    await Promise.all([
        getWethBalance(contracts, contracts.nftSec.options.address),
        getWethBalance(contracts, accounts.liquidator),
    ])
    .then(results => console.log(
        'wETH balances before liquidating collateral:',
        `\tNftSec contract: ${results[0]/10**18}`,
        `\tLiquidator     : ${results[1]/10**18}`,
    ))

    console.log('Liquidator is interested in Bored Ape 1, so she periodically checks the price ---')
    for (let i = 0; i < 4; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const nftPrice = await contracts.nftSec.methods.getNftPrice(contracts.bayc.options.address, 1).call()
        if (nftPrice === '3963877391197344453575983046348115674221700746820753546331534351508065746944') { // web3 revert message
            console.log('\tBored Ape 1 is not available for liquidation yet')
        } else {
            console.log(`\tBored Ape 1 is available for a price of ${nftPrice/10**18} ETH`)
        }
    }

    await contracts.nftSec.methods.liquidateNft(contracts.bayc.options.address, 1).send({from: accounts.liquidator})

    // Verify successful collateral liquidation and final wETH balances
    await Promise.all([
        contracts.bayc.methods.ownerOf(1).call(),
        getWethBalance(contracts, contracts.nftSec.options.address),
        getWethBalance(contracts, accounts.liquidator),
    ])
    .then(results => {
        if (results[0] === accounts.liquidator) {
            console.log('Bored Ape 1 transferred to Liquidator')
        }
        console.log(
            'wETH balances after repaying loan:',
            `\tNftSec contract: ${results[1]/10**18}`,
            `\tLiquidator     : ${results[2]/10**18}`,
        )
    })
}

// #region Transferring tranche tokens

/* Investors buy and sell tranche tokens on secondary market */
const transactTranches = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 6: Transacting fungible tokens...')

    // Verify tranche token ownership before transactions
    await Promise.all([
        contracts.nftSec.methods.balanceOf(accounts.investor1, 0).call(),
        contracts.nftSec.methods.balanceOf(accounts.investor2, 1).call(),
        contracts.nftSec.methods.balanceOf(accounts.investor3, 2).call(),
        contracts.nftSec.methods.balanceOf(accounts.investor4, 1).call(),
    ]).then(results => console.log(
        'Tranche token ownership before secondary market transactions:',
        `\tInvestor 1 owns ${results[0]/10**18} x 10^18 senior tranche tokens`,
        `\tInvestor 2 owns ${results[1]/10**18} x 10^18 junior tranche tokens`,
        `\tInvestor 3 owns ${results[2]} residual tranche token`,
        `\tInvestor 4 owns ${results[3]/10**18} x 10^18 junior tranche tokens`,
    ))

    // Investor 5 gets tokens from two other investors
    await Promise.all([
        contracts.nftSec.methods.safeTransferFrom(
            accounts.investor1,
            accounts.investor5,
            0,
            '300000000000000000',
            '0x00',
        ).send({from: accounts.investor1}),
        contracts.nftSec.methods.safeTransferFrom(
            accounts.investor2,
            accounts.investor5,
            1,
            '400000000000000000',
            '0x00',
        ).send({from: accounts.investor2}),
    ])

    // Verify tranche token ownership after transactions
    await Promise.all([
        contracts.nftSec.methods.balanceOf(accounts.investor1, 0).call(),
        contracts.nftSec.methods.balanceOf(accounts.investor3, 2).call(),
        contracts.nftSec.methods.balanceOf(accounts.investor4, 1).call(),
        contracts.nftSec.methods.balanceOf(accounts.investor5, 0).call(),
        contracts.nftSec.methods.balanceOf(accounts.investor5, 1).call(),
    ]).then(results => console.log(
        'Tranche token ownership after secondary market transactions:',
        `\tInvestor 1 owns ${results[0]/10**18} x 10^18 senior tranche tokens`,
        `\tInvestor 3 owns ${results[1]} residual tranche token`,
        `\tInvestor 4 owns ${results[2]/10**18} x 10^18 junior tranche tokens`,
        `\tInvestor 5 owns ${results[3]/10**18} x 10^18 senior tranche and ${results[4]/10**18} x 10^18 junior tranche tokens`
    ))
}

// #region Redeeming tranche tokens

/* All investors redeem their tranche tokens and receive wETH in return */
const redeemTranches = async (contracts: Contracts, accounts: Accounts): Promise<void> => {
    console.log('\nStep 7: Redeeming tokens...')

    // Verify initial wETH balances
    await Promise.all([
        getWethBalance(contracts, contracts.nftSec.options.address),
        getWethBalance(contracts, accounts.investor1),
        getWethBalance(contracts, accounts.investor3),
        getWethBalance(contracts, accounts.investor4),
        getWethBalance(contracts, accounts.investor5),
    ])
    .then(results => console.log(
        'wETH balances before redeeming tokens:',
        `\tNftSec contract: ${results[0]/10**18}`,
        `\tInvestor 1     : ${results[1]/10**18}`,
        `\tInvestor 3     : ${results[2]/10**18}`,
        `\tInvestor 4     : ${results[3]/10**18}`,
        `\tInvestor 5     : ${results[4]/10**18}`,
    ))

    console.log('Investor 3, who holds the residual token, waits for the product to mature ---')
    await new Promise(r => setTimeout(r, 20000))
    console.log('Investor 3 redeems her residual token, capturing the computation bounty')
    await contracts.nftSec.methods.redeemTokens(0).send({from: accounts.investor3})
    console.log('Investors 1, 4, and 5 also redeem their tokens afterwards')
    await Promise.all([
        contracts.nftSec.methods.redeemTokens(0).send({from: accounts.investor1}),
        contracts.nftSec.methods.redeemTokens(0).send({from: accounts.investor4}),
        contracts.nftSec.methods.redeemTokens(0).send({from: accounts.investor5}),
    ])

    // Verify final wETH balances
    await Promise.all([
        getWethBalance(contracts, contracts.nftSec.options.address),
        getWethBalance(contracts, accounts.investor1),
        getWethBalance(contracts, accounts.investor3),
        getWethBalance(contracts, accounts.investor4),
        getWethBalance(contracts, accounts.investor5),
    ])
    .then(results => console.log(
        'wETH balances after redeeming tokens:',
        `\tNftSec contract: ${results[0]/10**18}`,
        `\tInvestor 1     : ${results[1]/10**18}`,
        `\tInvestor 3     : ${results[2]/10**18}`,
        `\tInvestor 4     : ${results[3]/10**18}`,
        `\tInvestor 5     : ${results[4]/10**18}`,
    ))
}

/* Main body of scenario test */
(async () => {
    try {
        const accounts: Accounts = await Promise.all([
            MISC_ACC,
            NFTFI_ACC,
            BORROWER1_ACC,
            BORROWER2_ACC,
            STRUCTURER_ACC,
            INVESTOR1_ACC,
            INVESTOR2_ACC,
            INVESTOR3_ACC,
            INVESTOR4_ACC,
            INVESTOR5_ACC,
            LIQUIDATOR_ACC,
        ].map(getAccount)).then(result => { return {
            misc: result[0],
            nftfi: result[1],
            borrower1: result[2],
            borrower2: result[3],
            structurer: result[4],
            investor1: result[5],
            investor2: result[6],
            investor3: result[7],
            investor4: result[8],
            investor5: result[9],
            liquidator: result[10],
        }})

        const contracts = await init(accounts)
        await initiateLoans(contracts, accounts)
        await mintTranches(contracts, accounts)
        await investInTranches(contracts, accounts)
        await repayLoan(contracts, accounts)
        await liquidateNft(contracts, accounts)
        await transactTranches(contracts, accounts)
        await redeemTranches(contracts, accounts)
        console.log('\nEnd of test.')
    } catch (e) {
        console.error(e.message)
    }
})()